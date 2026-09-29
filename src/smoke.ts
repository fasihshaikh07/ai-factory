// `factory smoke`: the cheapest possible real check of every paid connection before a real run.
// Stops at the first failure. Expected total: a few cents.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hasSecret } from "./config/env.js";
import type { ProjectConfig } from "./config/project.js";
import type { ContextPack } from "./contracts/index.js";
import { ApiRunner, type Provider } from "./runners/api.js";
import { ClaudeAgentRunner } from "./runners/claude-agent.js";
import { AGENT_NET, API_PROXY, ensureAgentImage, ensureEgress, feedHostsFrom, PROXY_IMAGE } from "./runners/netinfra.js";
import { DEFAULT_ROUTES, modelFor } from "./stages/routing.js";
import { DEFAULT_POLICY } from "./gates/policy.js";
import { factoryHome } from "./util/paths.js";
import { stopAndRemove, type ContainerRuntime } from "./verify/runtime.js";

export interface SmokeCheck { name: string; ok: boolean; costUsd: number; detail: string }

export interface SmokeDeps {
  provider: (model: string) => Provider;
  rt: ContainerRuntime;
  project?: ProjectConfig;
  log: (line: string) => void;
  /** tests replace the real container parts */
  skipContainers?: boolean;
}

const CHEAP_AGENT_MODEL = "claude-haiku-4-5";

function tinyPack(): ContextPack {
  return {
    system: "You are a connectivity check. Answer by calling submit_result with ok set to true. Nothing else.",
    user: "ping", images: [], pointers: [], tools: [],
    manifest: { stage: "intake", model: "", recipeVersion: "smoke", sections: [], packTokens: 20, budgetTokens: 1000, countMethod: "proxy", redactions: 0, packSha: "0".repeat(64) },
  };
}

/** The distinct models the thinking steps will call (GPT only when an OpenAI key exists). */
export function modelsToCheck(project?: ProjectConfig): string[] {
  const p = project ?? ({ steps: {} } as unknown as ProjectConfig);
  const models = Object.entries(DEFAULT_ROUTES)
    .filter(([, r]) => r.runner === "api")
    .map(([stage]) => modelFor(p, stage, 0).model);
  const coding = Object.entries(DEFAULT_ROUTES).filter(([, r]) => r.runner !== "api").flatMap(([stage]) => [modelFor(p, stage, 0).model, ...(p.steps[stage]?.escalate ?? DEFAULT_ROUTES[stage]!.escalate)]);
  return [...new Set([...models, ...coding])].filter((m) => !/^gpt|^o\d/.test(m) || hasSecret("OPENAI_API_KEY")).sort();
}

export async function runSmoke(d: SmokeDeps): Promise<SmokeCheck[]> {
  const checks: SmokeCheck[] = [];
  const add = (c: SmokeCheck) => { checks.push(c); d.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}: ${c.detail}${c.costUsd ? ` ($${c.costUsd.toFixed(4)})` : ""}`); return c.ok; };

  if (!hasSecret("ANTHROPIC_API_KEY")) {
    add({ name: "key", ok: false, costUsd: 0, detail: "Add ANTHROPIC_API_KEY to ~/.factory/.env first. Nothing was spent." });
    return checks;
  }

  // a. one tiny call per model, through our own read-only loop
  for (const model of modelsToCheck(d.project)) {
    const r = await new ApiRunner({ provider: d.provider }).run({
      step: "intake", model, effort: "low", pack: tinyPack(), schema: z.object({ ok: z.literal(true) }),
      limits: { maxTurns: 2, maxUsd: 0.05, timeoutSec: 120 },
    });
    if (!add({ name: `model ${model}`, ok: r.status === "ok", costUsd: r.usage.estUsd, detail: r.status === "ok" ? `answered (${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens)` : `${r.status}: ${r.error ?? ""}` })) return checks;
  }
  if (d.skipContainers) return checks;

  // b. the key proxy: one 5-token request from a container on the sealed network
  await ensureEgress(d.rt, feedHostsFrom(DEFAULT_POLICY.registryAllowlist));
  const script = `fetch("http://${API_PROXY}:8080/anthropic/v1/messages",{method:"POST",headers:{"content-type":"application/json","anthropic-version":"2023-06-01","x-api-key":"placeholder"},body:JSON.stringify({model:"${CHEAP_AGENT_MODEL}",max_tokens:5,messages:[{role:"user",content:"ping"}]})}).then(async r=>{const j=await r.json().catch(()=>({}));console.log(r.status,JSON.stringify(j.usage??j.error??{}))}).catch(e=>console.log(0,e.message))`;
  const id = await d.rt.create({ image: PROXY_IMAGE, role: "producer", labels: { run: "smoke", key: "proxy" }, network: AGENT_NET, mounts: [], env: {}, cmd: ["node", "-e", script], user: "node" });
  let out = "";
  try {
    await d.rt.start(id);
    await d.rt.wait(id, 60_000);
    out = (await d.rt.logs(id)).trim();
  } finally {
    await stopAndRemove(d.rt, id);
  }
  const status = Number(out.split(" ")[0]);
  const u = /"input_tokens":(\d+).*"output_tokens":(\d+)/.exec(out);
  const proxyCost = u ? (Number(u[1]) * 1 + Number(u[2]) * 5) / 1_000_000 : 0;
  if (!add({ name: "key proxy", ok: status === 200, costUsd: proxyCost, detail: status === 200 ? "the sealed network reaches the API and the proxy adds the key" : `HTTP ${status || "no answer"}: ${out.slice(0, 200)}` })) return checks;

  // c. the coding agent in its sealed container, on a throwaway folder
  const sdk = d.project?.dotnet.sdkImage ?? "mcr.microsoft.com/dotnet/sdk:8.0";
  d.log("     (building or checking the coding-agent image; the first time takes a few minutes)");
  await ensureAgentImage(d.rt, sdk);
  const base = join(factoryHome(), "tmp");
  mkdirSync(base, { recursive: true });
  const work = mkdtempSync(join(base, "smoke-"));
  try {
    const r = await new ClaudeAgentRunner(d.rt, { runId: "smoke", key: "agent", fileScope: [], lockedFiles: [], extraProtected: [], agentEnv: {} }).run({
      step: "implement", model: CHEAP_AGENT_MODEL, pack: { ...tinyPack(), system: "Connectivity check for a coding agent.", user: "Create a file named hello.txt in the current folder containing exactly the word hello. Then finish with done set to true." },
      schema: z.object({ done: z.boolean() }), limits: { maxTurns: 5, maxUsd: 0.1, timeoutSec: 300 }, workdir: work,
    });
    const file = join(work, "hello.txt");
    const wrote = existsSync(file) && readFileSync(file, "utf8").trim().toLowerCase() === "hello";
    add({
      name: "coding agent (sealed container)", ok: r.status === "ok" && wrote, costUsd: r.usage.estUsd,
      detail: r.status !== "ok" ? `${r.status}: ${r.error ?? ""}` : wrote ? `wrote hello.txt in ${r.usage.turns} turns` : "finished but didn't write hello.txt",
    });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  return checks;
}
