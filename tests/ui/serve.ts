// Fixture server for the browser test and the screenshots (npm run test:ui): a throwaway
// FACTORY_HOME with sample runs in every state, and `factory ui` on top of it. The executor is a
// stub that appends steps every few hundred ms, so a run started from the page moves live.
// Never touches ~/.factory.
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";

const home = mkdtempSync(join(tmpdir(), "factory-ui-e2e-"));
process.env.FACTORY_HOME = home;
writeFileSync(join(home, ".env"), "ANTHROPIC_API_KEY=sk-ant-e2e-not-real-0000000000\nOPENAI_API_KEY=sk-e2e-not-real-000000000000\n", { mode: 0o600 });

const { _resetEnvCache } = await import("../../src/config/env.js");
_resetEnvCache();
const { HUMAN_WRITER, Ledger } = await import("../../src/ledger/ledger.js");
const { DEFAULT_POLICY } = await import("../../src/gates/policy.js");
const { runGate } = await import("../../src/gates/engine.js");
const P = await import("../../src/gates/predicates.js");
const { createRun } = await import("../../src/stages/executor.js");
const { createUiServer, listen } = await import("../../src/ui/server.js");

type Ev = Parameters<InstanceType<typeof Ledger>["append"]>[0];
const port = Number(process.env.UI_PORT ?? 4399);
const TOKEN = "e2e-token-0123456789abcdefgh";
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-ui-e2e-repo-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env: gitEnv });
  for (const [p, t] of Object.entries(files)) { mkdirSync(join(dir, p, ".."), { recursive: true }); writeFileSync(join(dir, p), t); }
  execFileSync("git", ["add", "-A"], { cwd: dir, env: gitEnv });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env: gitEnv });
  return dir;
}

mkdirSync(join(home, "projects"), { recursive: true });
writeFileSync(join(home, "projects", "shop-api.yaml"), stringify({ project: "shop-api", repo: repo({
  "src/Shop.Api/Shop.Api.csproj": '<Project Sdk="Microsoft.NET.Sdk.Web"></Project>\n',
  "src/Shop.Api/Program.cs": "var app = WebApplication.CreateBuilder(args).Build();\napp.Run();\n",
}), stack: "dotnet" }));
writeFileSync(join(home, "projects", "shop-web.yaml"), stringify({ project: "shop-web", repo: repo({
  "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
  "src/app/page.tsx": `import { Button } from "@/components/ui/button";\nexport default function Home() { return <main><h1>Shop</h1><Button>Go</Button></main>; }\n`,
  "src/app/orders/page.tsx": "export default function Orders() { return <h1>Your orders</h1>; }\n",
  "src/components/ui/button.tsx": "export function Button(p: { children: unknown }) { return <button>{p.children as string}</button>; }\n",
}), stack: "dotnet" }));

const T0 = Date.now() - 42 * 60_000;
const RealDate = Date;
/** Run fn with `new Date()` and Date.now() reading the fixture clock. */
async function at<T>(fn: () => Promise<T>): Promise<T> {
  const c = clock;
  class Fake extends RealDate {
    constructor(...a: unknown[]) { if (a.length) super(...(a as [number])); else super(c); }
    static override now() { return c; }
  }
  globalThis.Date = Fake as DateConstructor;
  try { return await fn(); } finally { globalThis.Date = RealDate; }
}
let clock = T0;
/** Append with timestamps spread over the last hour, so charts and times look like a real run. */
async function add(runId: string, evs: Ev[], gapSec = 40) {
  const l = Ledger.open(runId);
  for (const e of evs) {
    clock += gapSec * 1000 * (0.6 + Math.random() * 0.8);
    await at(() => l.append(e, HUMAN_WRITER));
  }
  return l;
}
const use = (key: string, usd: number, model = "claude-opus-5-5", tin = 9000, tout = 1400): Ev =>
  ({ type: "usage", key, data: { "gen_ai.request.model": model, "gen_ai.usage.cost_usd": usd, "gen_ai.usage.input_tokens": tin, "gen_ai.usage.output_tokens": tout, "gen_ai.usage.cache_read_tokens": tin * 3 } });
const done = (step: string, usd: number, model?: string, data: Record<string, unknown> = {}, outputs: string[] = []): Ev[] => [
  { type: "step.started", key: `${step}/1`, data: { rung: 0 } }, ...(usd ? [use(`${step}/1`, usd, model)] : []), { type: "step.completed", key: `${step}/1`, outputs, data },
];
async function gate(runId: string, def: Parameters<typeof runGate>[0], inputs: Record<string, unknown>, step: string) {
  const l = Ledger.open(runId);
  const shas = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, l.putJson(v)]));
  clock += 2000;
  await at(() => runGate(def, l, HUMAN_WRITER, shas, DEFAULT_POLICY, { step }));
}
const diff = (paths: string[]) => ({ from: "a".repeat(40), to: "b".repeat(40), files: paths.map((path) => ({ status: "M", path, added: ["return Results.NotFound();"], removed: [] })), lockedNow: {} });
const SPEC_STEPS: [string, number, string][] = [["discover", 0, ""], ["intake", 0.01, "claude-haiku-4-5"], ["ground", 0.34, "claude-opus-5-5"], ["clarify", 0.15, "claude-opus-5-5"], ["clarify-2", 0, ""], ["drafts", 0.27, "claude-sonnet-5"], ["merge", 0.11, "claude-opus-5-5"], ["specify", 0.62, "gpt-5.5"]];

async function specHalf(runId: string) {
  for (const [s, usd, m] of SPEC_STEPS) {
    await add(runId, done(s, usd, m));
    if (s === "ground") await gate(runId, P.anchorsResolve, { cb: {}, resolved: [{ claim: "C-1", ok: true }] }, "ground");
  }
  await add(runId, done("plan", 0.14, "claude-opus-5-5", { tasks: ["TASK-1", "TASK-2"], complexity: "S" }, [Ledger.open(runId).putJson({ tasks: [{ id: "TASK-1", fileScope: ["src/app/orders/page.tsx"] }, { id: "TASK-2", fileScope: ["src/Shop.Api/Program.cs"] }] })]));
}

async function approvalCard(runId: string) {
  const l = Ledger.open(runId);
  const sha = l.putJson({ card: runId });
  const cardId = `approval-${sha.slice(0, 8)}`;
  l.writeCard(cardId, [
    `# Approval: Return 404 when an order doesn't exist`, "", `Run ${runId} · risk **low** · bugfix · size S`, "",
    "## Your request (word for word, from typed prompt)", "> Return 404 Not Found when an order doesn't exist, instead of a 500.", "",
    "## Requirements", "- **REQ-1** (MODIFIED) When an order that does not exist is requested, the Shop API shall respond with 404 Not Found.",
    "  - AC-1.1 [api] Given no order 999; when GET /orders/999; then 404", "",
    "## Files the plan will touch (1)", "- src/Shop.Api/Program.cs", "",
    "## Decide", `  factory approve ${runId} <hash> --note "your risk note"`, `  factory reject  ${runId} <hash> --reason "why"`, "", `Card hash: ${sha.slice(0, 8)}`,
  ].join("\n"));
  await add(runId, [{ type: "step.started", key: "approve/1", data: { rung: 0 } }, { type: "step.interrupted", key: "approve/1", data: { reason: "waiting" } },
    { type: "human.requested", data: { cardId, kind: "approval", artifactSha: sha, step: "approve" } }]);
  return sha;
}

async function approved(runId: string) {
  const sha = await approvalCard(runId);
  await add(runId, [{ type: "human.decided", data: { cardId: `approval-${sha.slice(0, 8)}`, decision: "approve", by: "ahsan", artifactSha: sha } }, ...done("approve", 0)]);
}

async function buildHalf(runId: string, opts: { stopInTask2?: boolean } = {}) {
  await add(runId, [...done("stub-commit", 0), ...done("author-tests", 0.58, "claude-opus-5-5")]);
  await gate(runId, P.noSecrets, { scan: { kind: "secrets", commit: "c", hits: [] } }, "implement/TASK-1");
  // TASK-1: out of scope first, fixed on the retry
  await add(runId, [{ type: "step.started", key: "implement/TASK-1/1", data: { rung: 0 } }, use("implement/TASK-1/1", 0.31, "claude-sonnet-5")]);
  await gate(runId, P.diffInScope, { diff: diff(["src/app/orders/page.tsx", "src/app/layout.tsx"]), task: { fileScope: ["src/app/orders/page.tsx"] } }, "implement/TASK-1");
  const why = Ledger.open(runId).putJson([{ check: "diff-in-scope", message: "Changed src/app/layout.tsx, which is outside the task's file scope", frames: [] }]);
  await add(runId, [{ type: "step.failed", key: "implement/TASK-1/1", outputs: [why], data: { category: "other", signature: "scope", rung: 0, action: "retry", nextRung: 0, reason: "same rung, fresh attempt", retryMode: "reset" } },
    { type: "step.started", key: "implement/TASK-1/2", data: { rung: 0 } }, use("implement/TASK-1/2", 0.22, "claude-sonnet-5")]);
  await gate(runId, P.diffInScope, { diff: diff(["src/app/orders/page.tsx"]), task: { fileScope: ["src/app/orders/page.tsx"] } }, "implement/TASK-1");
  await gate(runId, P.noEscapeHatches, { diff: diff(["src/app/orders/page.tsx"]) }, "implement/TASK-1");
  await add(runId, [{ type: "step.completed", key: "implement/TASK-1/2", data: { commit: "c".repeat(40), retryMode: "reset" } }]);
  await add(runId, [{ type: "step.started", key: "implement/TASK-2/1", data: { rung: 0 } }, use("implement/TASK-2/1", 0.19, "claude-sonnet-5")]);
  if (opts.stopInTask2) return;
  await gate(runId, P.diffInScope, { diff: diff(["src/Shop.Api/Program.cs"]), task: { fileScope: ["src/Shop.Api/Program.cs"] } }, "implement/TASK-2");
  await add(runId, [{ type: "step.completed", key: "implement/TASK-2/1", data: { commit: "d".repeat(40) } }, ...done("integrate", 0), ...done("accept", 0)]);
  await gate(runId, P.diffSize, { diff: diff(["src/app/orders/page.tsx", "src/Shop.Api/Program.cs"]) }, "integrate");
  await add(runId, done("review", 0.24, "gpt-5.5"));
  await gate(runId, P.reviewBlocking, { review: { findings: [] }, families: { implementer: "claude", reviewer: "gpt" } }, "review");
}

// 1) delivered, with a preview
const delivered = await at(() => createRun("Show the order count next to the Your orders heading", "shop-web", "ahsan", { sources: [{ kind: "prompt" }] }));
await specHalf(delivered); await approved(delivered); await buildHalf(delivered);
await gate(delivered, P.shaBinding, { pushed: { headParent: "e".repeat(40), manifestOnly: true, changed: [".factory/evidence-manifest.json"] }, gatedSha: "e".repeat(40) }, "deliver");
await add(delivered, [...done("deliver", 0, undefined, { local: true, branch: `factory/${delivered}`, head: "f".repeat(40) }), { type: "run.delivered", data: { local: true, branch: `factory/${delivered}` } }]);
Ledger.open(delivered).writeCard(`pr-${delivered}`, "## What was asked\n> Show the order count next to the Your orders heading\n\n## Checks\n- Tests: 3 locked tests pass\n- Review: 0 non-blocking findings\n- Security review (OWASP Top 10): nothing found");
cpSync(join(import.meta.dirname, "../../src/ui/fixtures/preview"), join(Ledger.open(delivered).dir, "preview"), { recursive: true });

// 2) parked in review
clock = T0 + 5 * 60_000;
const parked = await at(() => createRun("Add a CSV export button to the orders page", "shop-web", "ahsan"));
await specHalf(parked); await approved(parked); await buildHalf(parked, { stopInTask2: true });
await add(parked, [{ type: "step.failed", key: "implement/TASK-2/1", data: { category: "locked-test", signature: "x", rung: 0, parked: true } },
  { type: "run.parked", data: { reason: "Locked test AC_1_1_ExportsCsv failed twice. Either the code or the test is wrong; a person needs to look.", step: "implement/TASK-2" } }]);

// 3) waiting at the approval card
clock = T0 + 15 * 60_000;
const waiting = await at(() => createRun("Return 404 Not Found when an order doesn't exist, instead of a 500", "shop-api", "ahsan", { sources: [{ kind: "prompt" }] }));
await specHalf(waiting); await approvalCard(waiting);

// 4) running, with a retry behind it (its executor "is" in implement/TASK-2)
clock = T0 + 20 * 60_000;
const running = await at(() => createRun("Rename the orders heading to Your orders", "shop-api", "ahsan"));
await specHalf(running); await approved(running); await buildHalf(running, { stopInTask2: true });

/** Stub executor for runs started from the page: a step every 700 ms. */
function stubExecute(runId: string) {
  const steps = ["discover", "intake", "ground", "clarify", "clarify-2", "drafts", "merge", "specify", "plan"];
  let i = 0;
  const l = Ledger.open(runId);
  const tick = async () => {
    const s = steps[i++];
    if (!s) return;
    await l.append({ type: "step.started", key: `${s}/1`, data: { rung: 0 } }, HUMAN_WRITER);
    await new Promise((r) => setTimeout(r, 350));
    await l.append(use(`${s}/1`, 0.05), HUMAN_WRITER);
    await l.append({ type: "step.completed", key: `${s}/1`, data: {} }, HUMAN_WRITER);
    setTimeout(tick, 350);
  };
  setTimeout(tick, 300);
}

const ui = createUiServer({ token: TOKEN, previewKey: "e2e-preview-key-0123456789", deps: { execute: stubExecute } });
const p = await listen(ui, port);
writeFileSync(join(home, "ids.json"), JSON.stringify({ delivered, parked, waiting, running }));
console.log(`ready http://127.0.0.1:${p}/?t=${TOKEN}`);
console.log(`ids ${JSON.stringify({ delivered, parked, waiting, running })}`);
