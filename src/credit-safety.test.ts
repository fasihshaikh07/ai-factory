// Credit safety: nothing should spend money on a run that can't succeed.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { _resetEnvCache } from "./config/env.js";
import type { ContextPack } from "./contracts/index.js";
import { checkCaps, currentCostCap } from "./ledger/caps.js";
import { HUMAN_WRITER, Ledger } from "./ledger/ledger.js";
import { replay } from "./ledger/state.js";
import { ApiRunner, ConfigError, type Provider } from "./runners/api.js";
import { agentImageFingerprint, proxyFingerprint } from "./runners/netinfra.js";
import { configErrorText } from "./runners/types.js";
import { runSmoke } from "./smoke.js";

beforeEach(() => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-credit-"));
  _resetEnvCache();
});

const pack: ContextPack = {
  system: "s", user: "u", images: [], pointers: [], tools: [],
  manifest: { stage: "intake", model: "m", recipeVersion: "1", sections: [], packTokens: 1, budgetTokens: 10, countMethod: "proxy", redactions: 0, packSha: "0".repeat(64) },
};
const U = { inputTokens: 100, outputTokens: 10, cacheRead: 0, cacheWrite: 0 };
const failing = (err: Error): Provider => ({ start: () => ({ next: async () => { throw err; }, toolResults() {}, say() {} }) });
const answering = (input: unknown): Provider => ({ start: () => ({ next: async () => ({ calls: [{ id: "1", name: "submit_result", input }], text: "", stop: "tool_use", usage: U }), toolResults() {}, say() {} }) });

describe("the key proxy restarts when keys change", () => {
  it("fingerprint depends on keys and code, and never contains them", () => {
    const none = proxyFingerprint({ MODE: "api", ANTHROPIC_API_KEY: undefined }, "code");
    const withKey = proxyFingerprint({ MODE: "api", ANTHROPIC_API_KEY: "sk-ant-secret-value" }, "code");
    expect(withKey).not.toBe(none);
    expect(withKey).not.toContain("secret");
    expect(proxyFingerprint({ MODE: "api", ANTHROPIC_API_KEY: "sk-ant-secret-value" }, "code v2")).not.toBe(withKey);
    expect(proxyFingerprint({ MODE: "api", ANTHROPIC_API_KEY: "sk-ant-secret-value" }, "code")).toBe(withKey);
  });

  it("the coding-agent image fingerprint changes with the SDK image", () => {
    expect(agentImageFingerprint("mcr.microsoft.com/dotnet/sdk:8.0")).not.toBe(agentImageFingerprint("mcr.microsoft.com/dotnet/sdk:9.0"));
  });
});

describe("config errors stop at once", () => {
  it("maps provider config errors to config-error, not a retryable failure", async () => {
    const r = await new ApiRunner({ provider: () => failing(new ConfigError(401, "invalid x-api-key")) })
      .run({ step: "intake", model: "claude-sonnet-5", pack, schema: z.object({ ok: z.boolean() }), limits: { maxTurns: 2, maxUsd: 1, timeoutSec: 30 } });
    expect(r.status).toBe("config-error");
    expect(r.error).toMatch(/API key was refused/);
  });

  it("explains each status in plain words", () => {
    expect(configErrorText(404, "model: claude-x", "claude-x")).toMatch(/Model not found/);
    expect(configErrorText(400, "bad", "m")).toMatch(/rejected the request/);
  });

  it("the Anthropic SDK's typed errors are what the provider checks", () => {
    // the provider tests `instanceof Anthropic.APIError` + status: make sure those classes exist
    expect(typeof Anthropic.AuthenticationError).toBe("function");
    expect(typeof Anthropic.NotFoundError).toBe("function");
  });
});

describe("spend limits", () => {
  async function run(id: string, data: Record<string, unknown> = {}) {
    const l = Ledger.create(id);
    await l.append({ type: "run.created", data: { mode: "brownfield", project: "p", ...data } }, HUMAN_WRITER);
    return l;
  }

  it("--max-cost lowers the limit but never raises it", async () => {
    const low = await run("mc-1", { maxCostUsd: 3 });
    expect(currentCostCap(replay(low.events()))).toBe(3);
    const high = await run("mc-2", { maxCostUsd: 50 });
    expect(currentCostCap(replay(high.events()))).toBe(10);
    await low.append({ type: "usage", data: { "gen_ai.usage.cost_usd": 3.2 } }, HUMAN_WRITER);
    expect(checkCaps(replay(low.events()))?.kind).toBe("cost");
  });

  it("the retry budget limits attempts", async () => {
    const l = await run("rb-1");
    for (let i = 1; i <= 2; i++) {
      await l.append({ type: "step.started", key: `plan/${i}` }, HUMAN_WRITER);
      await l.append({ type: "step.failed", key: `plan/${i}` }, HUMAN_WRITER);
    }
    expect(checkCaps(replay(l.events()), 2)?.kind).toBe("attempts");
    expect(checkCaps(replay(l.events()), 6)).toBeUndefined();
  });
});

describe("factory smoke", () => {
  it("refuses without a key and spends nothing", async () => {
    const lines: string[] = [];
    const checks = await runSmoke({ provider: () => answering({ ok: true }), rt: {} as never, log: (l) => lines.push(l), skipContainers: true });
    expect(checks).toEqual([expect.objectContaining({ name: "key", ok: false, costUsd: 0 })]);
  });

  it("checks each model and stops at the first failure", async () => {
    writeFileSync(join(process.env.FACTORY_HOME!, ".env"), "ANTHROPIC_API_KEY=sk-ant-test-0000000000000000\n", { mode: 0o600 });
    _resetEnvCache();
    const seen: string[] = [];
    const provider = (model: string) => { seen.push(model); return model === "claude-opus-5-5" ? failing(new ConfigError(404, "not found")) : answering({ ok: true }); };
    const checks = await runSmoke({ provider, rt: {} as never, log: () => undefined, skipContainers: true });
    const last = checks[checks.length - 1]!;
    expect(last).toMatchObject({ name: "model claude-opus-5-5", ok: false });
    expect(last.detail).toMatch(/Model not found/);
    expect(checks.slice(0, -1).every((c) => c.ok && c.costUsd > 0)).toBe(true);
    expect(seen).toContain("claude-haiku-4-5");
    expect(seen).not.toContain("gpt-5.5"); // no OpenAI key: GPT routes fall back to Claude
  });
});
