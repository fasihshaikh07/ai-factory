// `factory selftest`: one full run on a tiny sample repo, for $0. Real git, test lab, Postgres,
// coding container, gates, cards and delivery; only the models' answers are scripted.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify } from "yaml";
import { projectPath } from "../config/project.js";
import { verifyEvidence } from "../gates/engine.js";
import { decide } from "../ledger/human.js";
import { Ledger } from "../ledger/ledger.js";
import { replay } from "../ledger/state.js";
import { scoreRun } from "../report.js";
import { setAgentScript } from "../runners/claude-agent.js";
import { createRun, execute } from "../stages/executor.js";
import { setProviderFactory } from "../stages/think.js";
import { runtime } from "../stages/workspace.js";
import { factoryHome } from "../util/paths.js";
import { agentScript, REQUEST, SAMPLE_REPO, scriptedProvider } from "./script.js";

export const SELFTEST_PROJECT = "selftest";

export interface Check { name: string; ok: boolean; detail: string }

/** A fresh git repo with the sample shop in it. */
export function makeSampleRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [path, content] of Object.entries(SAMPLE_REPO)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "factory selftest", GIT_AUTHOR_EMAIL: "selftest@factory.local", GIT_COMMITTER_NAME: "factory selftest", GIT_COMMITTER_EMAIL: "selftest@factory.local" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "Sample shop"], { cwd: dir, env });
}

function writeProject(repo: string): void {
  mkdirSync(dirname(projectPath(SELFTEST_PROJECT)), { recursive: true });
  writeFileSync(projectPath(SELFTEST_PROJECT), `# Written by factory selftest; removed when it finishes.\n${stringify({
    project: SELFTEST_PROJECT, repo, baseBranch: "main", stack: "dotnet",
    dotnet: { solution: "Shop.sln", buildTimeoutSec: 900, testTimeoutSec: 600 },
    database: { name: "shop_test", user: "shop", producerEnv: { ConnectionStrings__Default: "Host={{DB_HOST}};Port={{DB_PORT}};Database={{DB_NAME}};Username={{DB_USER}};Password={{DB_PASSWORD}}" } },
    accept: { readyTimeoutSec: 180 },
  })}`);
}

/** Run the pipeline; approve the approval card the way a person would (recorded as by "selftest"). */
async function drive(runId: string, log: (m: string) => void): Promise<{ status: string; message: string }> {
  for (let i = 0; i < 5; i++) {
    const r = await execute(runId, (m) => log(`  ${m}`));
    if (r.status !== "waiting") return r;
    const ledger = Ledger.open(runId);
    const card = replay(ledger.events()).openCard;
    if (card?.kind !== "approval") return { status: "stuck", message: `unexpected ${card?.kind ?? "?"} card: ${r.message}` };
    log(`  (selftest approves the card ${card.artifactSha.slice(0, 8)})`);
    await decide(ledger, { decision: "approve", hashPrefix: card.artifactSha.slice(0, 8), by: "selftest", data: { note: "selftest" } });
  }
  return { status: "stuck", message: "the run kept stopping" };
}

/** What the finished run proves, piece by piece. */
export async function checklist(runId: string): Promise<Check[]> {
  const ledger = Ledger.open(runId);
  const s = replay(ledger.events());
  const events = ledger.events();
  const trace = existsSync(join(ledger.dir, "run.log")) ? readFileSync(join(ledger.dir, "run.log"), "utf8") : "";
  const step = (k: string) => s.steps.get(k)?.status === "completed";
  const gate = (id: string) => s.gates.some((g) => g.gateId === id && g.passed);
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail = "") => out.push({ name, ok, detail });

  const d = s.steps.get("discover")?.data as { tests?: number; knownFailures?: number } | undefined;
  add("Baseline: restore through the feed proxy, offline build, tests next to Postgres", step("discover") && d?.tests === 2 && d.knownFailures === 0,
    `${d?.tests ?? 0} tests, ${d?.knownFailures ?? "?"} failing`);
  add("Spec: intake, grounding, clarify, 3 drafts, merge, lint, critic, round trip", ["intake", "ground", "clarify", "drafts", "merge", "specify"].every(step));
  add("Plan and approval card (approved with its hash)", step("plan") && step("approve") && events.some((e) => e.type === "human.decided"));
  add("Stub commit on the run's worktree", step("stub-commit"));
  add("Test writer in the coding container; its tests fail on the old code twice, then locked",
    step("author-tests") && gate("author-tests.fails-on-base") && /test writer: agent finished: ok/.test(trace));
  add("Coding container fixes it; diff, lock, config and secret checks pass; locked tests pass",
    step("implement/TASK-1") && gate("tests.expectations") && /implementer: agent finished: ok/.test(trace));
  add("Integrate: full suite, nothing new failing", step("integrate"));
  const acc = s.steps.get("accept")?.outputs[0];
  const ev = acc ? ledger.getJson<{ app?: { ok: boolean }; items: { ac: string; passed: boolean }[] }>(acc) : undefined;
  add("Accept: the app boots next to Postgres; GET /orders/999 → 404 recorded as evidence",
    step("accept") && ev?.app?.ok === true && ev.items.some((i) => i.ac === "AC-1.1" && i.passed), /probe GET \/orders\/999 → \d+/.exec(trace)?.[0] ?? "no probe in the trace");
  add("Review", step("review"));
  let branchOk = false;
  try {
    const log = execFileSync("git", ["log", "--format=%s", `main..factory/${runId}`], { cwd: s.info.repoPath!, encoding: "utf8" });
    branchOk = /evidence manifest/.test(log.split("\n")[0] ?? "");
  } catch { /* no branch */ }
  add("Deliver: branch with the change and a manifest commit; the SHA binding holds", step("deliver") && gate("deliver.sha-binding") && branchOk, `branch factory/${runId}`);
  const bad = verifyEvidence(ledger).filter((c) => !c.ok);
  add("Every recorded check re-verifies from the ledger", bad.length === 0, bad.map((c) => JSON.stringify(c)).join("; ").slice(0, 200));
  const score = scoreRun(ledger);
  add("Trace and scorecard written", trace.length > 0 && existsSync(join(ledger.dir, "report.json")) && score.steps.length > 10, `factory logs ${runId}`);
  let left: unknown[] = [];
  try { left = await runtime().listByLabel("factory.run", runId); } catch { /* no runtime */ }
  add("Every container of the run was removed", left.length === 0, left.length ? `${left.length} left` : "");
  add("Cost $0.00 (models scripted)", s.costUsd === 0, `$${s.costUsd.toFixed(2)}`);
  return out;
}

export async function runSelftest(opts: { keep?: boolean; log: (m: string) => void }): Promise<{ ok: boolean; runId?: string; checks: Check[] }> {
  const { log } = opts;
  const home = join(factoryHome(), "selftest");
  const repo = join(home, "repo");
  const started = Date.now();
  makeSampleRepo(repo);
  writeProject(repo);
  rmSync(join(factoryHome(), "repos", SELFTEST_PROJECT), { recursive: true, force: true }); // baseline runs every time
  setProviderFactory(() => scriptedProvider);
  setAgentScript(agentScript);
  let runId: string | undefined;
  try {
    runId = await createRun(REQUEST, SELFTEST_PROJECT, "selftest");
    log(`selftest run ${runId} on a sample repo (${repo})`);
    const r = await drive(runId, log);
    log(`\n${r.status}: ${r.message}`);
    const checks = await checklist(runId);
    log("");
    for (const c of checks) log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.detail ? `  (${c.detail})` : ""}`);
    const ok = r.status === "delivered" && checks.every((c) => c.ok);
    log(`\n${ok ? "Selftest passed" : "Selftest FAILED; see factory logs " + runId}. ${Math.round((Date.now() - started) / 60_000)} min, $0.00.`);
    return { ok, runId, checks };
  } finally {
    if (!opts.keep) {
      const wt = runId ? replay(Ledger.open(runId).events()).workspace?.path : undefined;
      if (wt) rmSync(wt, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(projectPath(SELFTEST_PROJECT), { force: true });
    }
  }
}
