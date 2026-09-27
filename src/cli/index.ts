#!/usr/bin/env node
// factory CLI (run-manager §2.8). Decisions (approve/reject/...) work only on a terminal.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { hasSecret } from "../config/env.js";
import { loadProject, projectPath } from "../config/project.js";
import { verifyEvidence } from "../gates/engine.js";
import "../gates/predicates.js";
import { assertTty, decide, DecisionError } from "../ledger/human.js";
import { HUMAN_WRITER, Ledger } from "../ledger/ledger.js";
import { replay, statusLabel } from "../ledger/state.js";
import { createRun, execute } from "../stages/executor.js";
import { checkRoutes } from "../stages/routing.js";
import { findRuntimeBinary } from "../verify/runtime.js";
import { factoryHome } from "../util/paths.js";

const log = (m: string): void => { process.stdout.write(`${m}\n`); };

function openRun(runId: string): Ledger {
  if (!Ledger.exists(runId)) {
    const matches = Ledger.listRuns().filter((r) => r.includes(runId));
    if (matches.length === 1) return Ledger.open(matches[0]!);
    throw new Error(matches.length ? `"${runId}" matches several runs: ${matches.join(", ")}` : `No run ${runId}`);
  }
  return Ledger.open(runId);
}

async function runAndReport(runId: string): Promise<void> {
  const r = await execute(runId, log);
  log(`\n${r.status}: ${r.message}`);
}

const program = new Command();
program.name("factory").description("AI Factory: turns a request into a verified PR").version("0.1.0");

program.command("start")
  .argument("<prompt>", "what you want changed, in plain words")
  .requiredOption("--project <name>", "project config in ~/.factory/projects/<name>.yaml")
  .description("create a run and execute until a card, a park, or delivery")
  .action(async (prompt: string, o: { project: string }) => {
    const project = loadProject(o.project);
    const problems = checkRoutes(project);
    if (problems.length) throw new Error(`Setup problems:\n- ${problems.join("\n- ")}`);
    const runId = await createRun(prompt, o.project, userInfo().username);
    log(`run ${runId}`);
    await runAndReport(runId);
  });

program.command("resume").argument("<run>").description("continue a run").action(async (run: string) => {
  await runAndReport(openRun(run).runId);
});

program.command("status").argument("[run]").description("state, current step, cost, open card").action((run?: string) => {
  const runs = run ? [openRun(run).runId] : Ledger.listRuns().slice(-10);
  if (!runs.length) return log("No runs yet.");
  for (const id of runs) {
    const s = replay(Ledger.open(id).events());
    const steps = [...s.steps.values()];
    const current = s.inFlight?.step ?? steps.filter((x) => x.status !== "completed").pop()?.step ?? steps[steps.length - 1]?.step ?? "-";
    log(`${id}  ${statusLabel(s.status).padEnd(10)} step ${current.padEnd(18)} $${s.costUsd.toFixed(2)}${s.openCard ? `  card: ${s.openCard.kind} ${s.openCard.artifactSha.slice(0, 8)}` : ""}${s.parkedReason ? `\n    parked: ${s.parkedReason}` : ""}`);
    if (run) for (const x of steps) log(`    ${x.status.padEnd(11)} ${x.step}  (attempts ${x.attempts})`);
  }
});

program.command("show-card").argument("<run>").option("--pr", "show the PR text").description("print the open card").action((run: string, o: { pr?: boolean }) => {
  const l = openRun(run);
  if (o.pr) return log(l.readCard(`pr-${l.runId}`));
  const s = replay(l.events());
  if (!s.openCard) return log(s.parkedReason ? `No open card. Parked: ${s.parkedReason}` : "No open card.");
  log(l.readCard(s.openCard.cardId));
});

for (const d of ["approve", "reject"] as const) {
  program.command(d).argument("<run>").argument("<hash>", "first characters of the card hash")
    .option("--note <text>", "your risk note (approve)")
    .option("--reason <text>", "why (reject)")
    .description(`${d} the open card (terminal only)`)
    .action(async (run: string, hash: string, o: { note?: string; reason?: string }) => {
      assertTty();
      const l = openRun(run);
      const r = await decide(l, { decision: d, hashPrefix: hash, data: d === "approve" ? { note: o.note ?? "" } : { reason: o.reason ?? "" } });
      log(r.kind === "repeat" ? "Already recorded." : `${d}d.`);
      if (d === "approve" && r.kind === "recorded") await runAndReport(l.runId);
    });
}

program.command("answer").argument("<run>").argument("<hash>", "first characters of the card hash")
  .argument("<answers...>", 'Q-1=A Q-2="your own words"')
  .description("answer the open question card (terminal only)")
  .action(async (run: string, hash: string, pairs: string[]) => {
    assertTty();
    const answers: Record<string, string> = {};
    for (const p of pairs) {
      const m = /^(Q-\d+)=(.+)$/s.exec(p);
      if (!m) throw new DecisionError(`Can't read "${p}". Use Q-1=A or Q-1="words".`);
      answers[m[1]!] = m[2]!;
    }
    const l = openRun(run);
    const r = await decide(l, { decision: "answer", hashPrefix: hash, data: { answers } });
    log(r.kind === "repeat" ? "Already recorded." : "Answers recorded; unanswered questions use the recommended option.");
    if (r.kind === "recorded") await runAndReport(l.runId);
  });

for (const c of ["pause", "stop"] as const) {
  program.command(c).argument("<run>").description(`${c} a run at the next step boundary`).action(async (run: string) => {
    const l = openRun(run);
    await l.append({ type: c === "pause" ? "run.pause-requested" : "run.stop-requested" }, HUMAN_WRITER);
    log(`${c} requested; it takes effect at the next step boundary.`);
  });
}

program.command("steer").argument("<run>").argument("<file>", "a text file describing the change").description("record a requirement change (applied at the next step boundary)")
  .action(async (run: string, file: string) => {
    assertTty();
    const l = openRun(run);
    const sha = l.putArtifact(readFileSync(file, "utf8"));
    await l.append({ type: "change.received", data: { sha, by: userInfo().username } }, HUMAN_WRITER);
    log("Change recorded. Note: applying changes mid-run (re-spec, re-plan) isn't built yet; the run will park when it sees it.");
  });

program.command("verify-evidence").argument("<run>").description("re-check every recorded gate decision").action((run: string) => {
  const checks = verifyEvidence(openRun(run));
  for (const c of checks) log(`${c.ok ? "ok  " : "FAIL"} #${c.seq} ${c.gateId}${c.reason ? `: ${c.reason}` : ""}`);
  log(checks.every((c) => c.ok) ? `All ${checks.length} decisions re-check.` : "Some decisions don't re-check.");
  if (!checks.every((c) => c.ok)) process.exitCode = 1;
});

program.command("doctor").description("check this machine and the setup").action(() => {
  const ok = (b: boolean, m: string, fix?: string) => log(`${b ? "ok  " : "MISSING"} ${m}${!b && fix ? `\n      → ${fix}` : ""}`);
  ok(Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.version}`, "install Node 22 with nvm");
  ok(process.platform === "linux" && !process.cwd().startsWith("/mnt/"), "running inside Linux (WSL2), not on a Windows drive");
  let rt = "";
  try { rt = findRuntimeBinary(); } catch (e) { rt = ""; ok(false, "container runtime", (e as Error).message); }
  if (rt) ok(true, `container runtime: ${rt}`);
  ok(existsSync(join(factoryHome(), ".env")), "~/.factory/.env exists", "create it yourself with your API keys (never paste keys into chat)");
  ok(hasSecret("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY set in ~/.factory/.env");
  log(`${hasSecret("OPENAI_API_KEY") ? "ok  " : "note"} OPENAI_API_KEY ${hasSecret("OPENAI_API_KEY") ? "set" : "not set: critic and review will use Claude (single family)"}`);
  const projects = existsSync(join(factoryHome(), "projects")) ? readdirSync(join(factoryHome(), "projects")).filter((f) => f.endsWith(".yaml")) : [];
  ok(projects.length > 0, `projects: ${projects.join(", ") || "none"}`, `create ${projectPath("<name>")} (see docs/project-example.yaml)`);
});

program.parseAsync().catch((e: Error) => {
  if (e instanceof DecisionError) process.stderr.write(`${e.message}\n`);
  else process.stderr.write(`error: ${e.message}\n`);
  process.exitCode = 1;
});
