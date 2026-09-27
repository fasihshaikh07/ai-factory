// Build side of the brownfield slice (stages-aligned §1): discover/baseline → stub commit →
// author-tests (fails on base twice → lock) → implement ⟲ task verify → integrate → accept.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Failure, PlanBody, SpecDraft, TestRun } from "../contracts/index.js";
import { scanText } from "../context/secrets.js";
import { failure, runGate, type GateDef } from "../gates/engine.js";
import {
  configIntegrity, diffInScope, diffSize, failsOnBase, lockSetUnchanged, noEscapeHatches, noSecrets, testExpectations,
  type DiffSummary,
} from "../gates/predicates.js";
import { CONFIG_INTEGRITY_GLOBS } from "../gates/protected.js";
import { matchesAny } from "../util/glob.js";
import { failureSignature } from "../gates/ladder.js";
import { changedFiles, commitAll, diffIncludingUntracked, git, headSha, repoRefusals, resetHard } from "../ledger/git.js";
import { ClaudeAgentRunner } from "../runners/claude-agent.js";
import { ensureAgentImage, ensureEgress, feedHostsFrom } from "../runners/netinfra.js";
import { buildPack } from "../context/pack.js";
import { Redactor } from "../context/secrets.js";
import { sha256 } from "../util/hash.js";
import { factoryHome } from "../util/paths.js";
import { produceDotnetTests, type ProduceOutput } from "../verify/dotnet.js";
import type { Expectations } from "../verify/validate.js";
import { header, requireOutput, type StepContext, type StepDef, type StepOutcome } from "./framework.js";
import { modelFor } from "./routing.js";
import { S } from "./think.js";
import { ensureWorktree, runtime, snapshotFor } from "./workspace.js";

type Plan = z.infer<typeof PlanBody> & { complexity: string };
type Spec = z.infer<typeof SpecDraft>;

interface Lock { tests: { acId: string; file: string; name: string; testId: string }[]; characterisation: { target: string; file: string; testId: string }[]; lock: { file: string; sha: string }[] }

const packagesDir = (runId: string) => {
  const d = join(factoryHome(), "tmp", runId, "nuget");
  mkdirSync(d, { recursive: true });
  return d;
};

async function produce(ctx: StepContext, key: string, commit: string, stage: TestRun["stage"], exp: Expectations, onlyTests?: string[]): Promise<ProduceOutput> {
  const rt = runtime();
  await ensureEgress(rt, feedHostsFrom(ctx.policy.registryAllowlist));
  return produceDotnetTests({
    runId: ctx.runId, key, repo: ctx.state.info.repoPath!, commit, stage, exp, project: ctx.project, rt, onlyTests,
    packagesDir: packagesDir(ctx.runId),
    onContainer: async (id, role) => { await ctx.ledger.append({ type: "container.started", key, data: { id, role } }, ctx.writer); },
    onRemoved: async (id) => { await ctx.ledger.append({ type: "container.removed", key, data: { id } }, ctx.writer); },
  });
}

function storeRun(ctx: StepContext, out: ProduceOutput): { testRun: string; build: string; reports: string[] } {
  return {
    testRun: ctx.ledger.putJson(out.testRun),
    build: ctx.ledger.putJson(out.build),
    reports: out.reports.map((r) => ctx.ledger.putArtifact(r.content)),
  };
}

// ---------- discover (D) ----------
const REFUSE: { code: string; re: RegExp; reason: string }[] = [
  { code: "testcontainers", re: /Testcontainers/i, reason: "Tests start their own Docker containers (Testcontainers); not supported in the POC." },
  { code: "sqlserver", re: /UseSqlServer|Microsoft\.EntityFrameworkCore\.SqlServer|System\.Data\.SqlClient/, reason: "Uses SQL Server; the POC supports Postgres only." },
  { code: "windows-only", re: /<UseWPF>true|<UseWindowsForms>true|<TargetFramework>net4\d/i, reason: "Windows-only target (WPF, WinForms or .NET Framework)." },
];

export const discoverStep: StepDef = {
  key: "discover", stage: "discover", templateVersion: "1",
  inputs: (s) => ({ base: s.info.baseCommit }),
  async run(ctx) {
    const repo = ctx.state.info.repoPath!;
    const refusals = await repoRefusals(repo);
    const snap = snapshotFor(ctx);
    for (const f of snap.files.filter((f) => /\.(csproj|props|cs)$/.test(f))) {
      const text = readFileSync(join(snap.root, f), "utf8");
      for (const r of REFUSE) if (r.re.test(text) && !refusals.some((x) => x.code === r.code)) refusals.push({ code: r.code, reason: `${r.reason} (${f})` });
    }
    if (refusals.length) return { kind: "park", reason: `This repo can't be used yet: ${refusals.map((r) => r.reason).join(" ")}` };

    // baseline: cached per repo + commit
    const cacheFile = join(factoryHome(), "repos", ctx.project.project, `baseline-${ctx.state.info.baseCommit}.json`);
    let baseline: TestRun;
    if (existsSync(cacheFile)) {
      baseline = JSON.parse(readFileSync(cacheFile, "utf8")) as TestRun;
      ctx.log("baseline: reusing the recorded run for this commit");
    } else {
      ctx.log("baseline: building and testing the untouched repo (first time is slow)");
      const out = await produce(ctx, "discover", ctx.state.info.baseCommit!, "baseline", { expectPass: [], expectFail: [], compareToBaseline: [] });
      if (!out.build.ok) return { kind: "park", reason: `The untouched repo doesn't build in the test lab: ${out.build.errors.slice(0, 3).map((e) => `${e.file ? `${e.file}:${e.line} ` : ""}${e.code === "RESTORE" ? "" : `${e.code} `}${e.msg}`).join("; ") || "see restore/build log"}` };
      baseline = out.testRun;
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify(baseline));
    }
    const failed = baseline.results.filter((r) => r.outcome === "failed").length;
    const sha = ctx.ledger.putJson(baseline);
    ctx.log(`baseline: ${baseline.results.length} tests, ${failed} failing before any change`);
    return { kind: "done", outputs: { baseline: sha }, data: { tests: baseline.results.length, knownFailures: failed, status: failed ? "green-with-known-failures" : "green" } };
  },
};

// ---------- stub commit (D) ----------
export const stubCommitStep: StepDef = {
  key: "stub-commit", stage: "stub-commit", templateVersion: "1",
  inputs: (s) => (s.steps.get("approve")?.status === "completed" ? { plan: s.steps.get("plan")!.outputs[0], approval: s.steps.get("approve")!.outputs[0] } : undefined),
  coding: true,
  async run(ctx) {
    const plan = requireOutput<Plan>(ctx.state, ctx.ledger, "plan");
    const wt = await ensureWorktree(ctx, ctx.state.info.baseCommit!);
    await resetHard(wt, ctx.state.info.baseCommit!);
    for (const s of plan.stubs) {
      mkdirSync(dirname(join(wt, s.path)), { recursive: true });
      writeFileSync(join(wt, s.path), s.content);
    }
    const commit = plan.stubs.length ? await commitAll(wt, `factory: interface stubs for ${ctx.runId}`) : await headSha(wt);
    return { kind: "done", outputs: { stubs: ctx.ledger.putJson({ commit, files: plan.stubs.map((s) => s.path) }) }, treeSha: commit, data: { commit } };
  },
};

// ---------- author-tests (A) + fails on base twice + lock ----------
const AuthorOut = z.object({
  tests: z.array(z.object({ acId: z.string(), file: z.string(), name: z.string(), testId: z.string() })).min(1),
  characterisation: z.array(z.object({ target: z.string(), file: z.string(), testId: z.string() })),
  notes: z.string(),
});

const TEST_SCOPE = ["**/*Test*/**", "**/*test*/**", "tests/**", "test/**"];

export const authorTestsStep: StepDef = {
  key: "author-tests", stage: "author-tests", templateVersion: "1", coding: true,
  inputs: (s) => (s.steps.get("stub-commit")?.status === "completed" ? { stubs: s.steps.get("stub-commit")!.outputs[0], spec: s.steps.get("specify")!.outputs[0] } : undefined),
  async run(ctx) {
    const spec = requireOutput<Spec>(ctx.state, ctx.ledger, "specify");
    const plan = requireOutput<Plan>(ctx.state, ctx.ledger, "plan");
    const start = String(ctx.state.steps.get("stub-commit")!.data!.commit);
    const wt = await ensureWorktree(ctx, start);
    await resetHard(wt, start);
    const { model, effort } = modelFor(ctx.project, "author-tests", ctx.rung);
    const rt = runtime();
    await ensureEgress(rt, feedHostsFrom(ctx.policy.registryAllowlist));
    await ensureAgentImage(rt, ctx.project.dotnet.sdkImage);
    // The test author sees ACs, stub signatures and harness rules. Never the plan's approach.
    const acs = spec.requirements.flatMap((r) => r.acceptance.map((a) => ({ req: r.id, ...a })));
    const pack = buildPack({
      stage: "author-tests", cls: "agent", model, recipeVersion: "1", tools: [], redactor: new Redactor(),
      sections: [
        S.template("tpl", `You write black-box acceptance tests for a .NET service, one test per acceptance criterion, before the feature exists.
Rules:
- Put tests in the existing test project that best fits (look for *Tests.csproj). Follow the style of existing tests there (xUnit, WebApplicationFactory if used).
- Test through public surfaces only: HTTP endpoints, public service methods, database rows. Don't test private code.
- Name each test after its AC, e.g. AC_1_2_Returns404WhenOrderMissing.
- New APIs exist as stubs that throw NotImplementedException; tests must compile against them and fail for now.
- Also write characterisation tests for existing behaviour next to the change that must NOT change; those must pass today.
- Don't change production code. Don't change test project files unless a package reference is missing and already restored.
- You may run "dotnet build" to check the tests compile. There's no database in this container; don't try to make tests pass.
- testId format: <TestProjectName>::<Namespace>.<Class>.<Method>
Return the list of tests you wrote.`),
        S.artifact("acs", "acceptance-criteria", acs),
        S.artifact("stubs", "stubs", plan.stubs.map((s) => ({ path: s.path, content: s.content }))),
        S.task("Write the acceptance and characterisation tests now."),
        S.recap(["one test per AC", "tests fail now for the right reason", "characterisation tests pass today", "don't touch production code"]),
      ],
    });
    const r = await new ClaudeAgentRunner(rt, {
      runId: ctx.runId, key: `author-tests/${ctx.attempt}`, fileScope: TEST_SCOPE, lockedFiles: [], extraProtected: [],
      protectedGlobs: CONFIG_INTEGRITY_GLOBS, packagesDir: packagesDir(ctx.runId), agentEnv: ctx.project.agentEnv,
      onContainer: async (id) => { await ctx.ledger.append({ type: "container.started", key: "author-tests", data: { id, role: "agent" } }, ctx.writer); },
      onRemoved: async (id) => { await ctx.ledger.append({ type: "container.removed", key: "author-tests", data: { id } }, ctx.writer); },
    }).run({ step: "author-tests", model, effort, pack, schema: AuthorOut, limits: { maxTurns: 60, maxUsd: 4, timeoutSec: 45 * 60 }, workdir: wt });
    await ctx.usage({ model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite, turns: r.usage.turns, wallMs: r.usage.wallMs, estUsd: r.usage.estUsd });
    if (r.status !== "ok") return { kind: "fail", category: r.status === "rate-limited" ? "rate-limit" : "other", failures: [failure(`agent-${r.status}`, r.error ?? r.status)], signature: `author-tests:${r.status}` };
    const out = r.output as z.infer<typeof AuthorOut>;

    const commit = await commitAll(wt, `factory: acceptance tests for ${ctx.runId}`);
    const changed = await changedFiles(wt, start, commit);
    const notTests = changed.filter((c) => !matchesAny(c.path, TEST_SCOPE));
    if (notTests.length) return { kind: "fail", category: "safety", failures: notTests.map((c) => failure("author-tests-scope", `Test author changed a non-test file: ${c.path}`)), signature: "author-tests:scope" };
    const missingAc = acs.filter((a) => a.level !== "manual" && !out.tests.some((t) => t.acId === a.id));
    if (missingAc.length) return { kind: "fail", category: "other", failures: missingAc.map((a) => failure("ac-coverage", `No test for ${a.id}`)), signature: "author-tests:coverage" };

    const exp: Expectations = {
      expectPass: out.characterisation.map((c) => c.testId),
      expectFail: out.tests.map((t) => ({ id: t.testId, kinds: ["assertion", "not-implemented"] })),
      compareToBaseline: [],
    };
    const only = [...out.tests.map((t) => t.testId), ...out.characterisation.map((c) => c.testId)];
    ctx.log("author-tests: running the new tests on the old code, twice");
    const run1 = storeRun(ctx, await produce(ctx, "author-tests/base-1", commit, "author-tests-on-base", exp, only));
    const run2 = storeRun(ctx, await produce(ctx, "author-tests/base-2", commit, "author-tests-on-base", exp, only));
    const lock: Lock = {
      tests: out.tests, characterisation: out.characterisation,
      lock: changed.filter((c) => c.status !== "D").map((c) => ({ file: c.path, sha: sha256(readFileSync(join(wt, c.path))) })),
    };
    const lockSha = ctx.ledger.putJson({ ...lock, unlocks: [], header: header(ctx.runId, "acceptance-tests", "author-tests", "", model) });
    const g = await runGate(failsOnBase, ctx.ledger, ctx.writer, { run1: run1.testRun, run2: run2.testRun, tests: lockSha }, ctx.policy, { step: "author-tests", treeSha: commit });
    if (!g.passed) {
      await resetHard(wt, start);
      return { kind: "fail", category: "other", failures: g.failures ?? [], signature: failureSignature((g.failures ?? []).map((f) => f.message)) };
    }
    return { kind: "done", outputs: { tests: lockSha, run1: run1.testRun, run2: run2.testRun }, treeSha: commit, data: { commit, locked: lock.lock.length } };
  },
};

// ---------- implement per task (A) ⟲ task verify (D) ----------
const ImplementOut = z.object({ done: z.boolean(), filesChanged: z.array(z.string()), notes: z.string() });

export async function diffSummary(wt: string, from: string, to: string, lock: Lock): Promise<DiffSummary> {
  const files = await changedFiles(wt, from, to);
  const out: DiffSummary["files"] = [];
  for (const f of files) {
    const patch = (await git(wt, ["diff", "--no-color", "-U0", from, to, "--", f.path])).stdout;
    out.push({
      status: f.status, path: f.path,
      added: patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1)),
      removed: patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---")).map((l) => l.slice(1)),
    });
  }
  const lockedNow: Record<string, string | null> = {};
  for (const l of lock.lock) {
    const p = join(wt, l.file);
    lockedNow[l.file] = existsSync(p) ? sha256(readFileSync(p)) : null;
  }
  return { from, to, files: out, lockedNow };
}

function secretScanOf(diff: DiffSummary, commit: string) {
  return { kind: "secrets" as const, commit, hits: diff.files.flatMap((f) => scanText(f.path, f.added.join("\n"))) };
}

function acIdsFor(spec: Spec, reqs: string[]): string[] {
  return spec.requirements.filter((r) => reqs.includes(r.id)).flatMap((r) => r.acceptance.map((a) => a.id));
}

/** Run gates; classify for the ladder: safety > locked-test > other. */
async function gateAll(ctx: StepContext, step: string, treeSha: string, gates: [GateDef, Record<string, string>][]): Promise<{ failures: Failure[]; category: "safety" | "locked-test" | "other"; lockedFailedIds: string[] } | undefined> {
  const failures: Failure[] = [];
  let safety = false;
  for (const [def, inputs] of gates) {
    const r = await runGate(def, ctx.ledger, ctx.writer, inputs, ctx.policy, { step, treeSha });
    if (!r.passed) {
      failures.push(...(r.failures ?? [failure(def.id, r.details)]));
      if (def.safety && def.id !== "tests.expectations") safety = true;
    }
  }
  if (!failures.length) return undefined;
  const lockedFailedIds = failures.filter((f) => f.check === "locked-failed" || f.check === "locked-flaky").map((f) => f.testId!).filter(Boolean);
  const evidence = failures.some((f) => f.check === "evidence" || f.check === "locked-not-executed");
  return { failures, category: safety || evidence ? "safety" : lockedFailedIds.length ? "locked-test" : "other", lockedFailedIds };
}

export function implementStep(taskId: string): StepDef {
  const key = `implement/${taskId}`;
  return {
    key, stage: "implement", templateVersion: "1", coding: true,
    inputs: (s) => {
      if (s.steps.get("author-tests")?.status !== "completed") return undefined;
      const plan = s.steps.get("plan")!.outputs[0];
      // taskStartSha: the previous task's commit, or the tests commit
      const prev = [...s.steps.values()].filter((r) => r.step.startsWith("implement/") && r.status === "completed" && r.step !== key);
      const start = prev.length ? String(prev[prev.length - 1]!.data?.commit) : String(s.steps.get("author-tests")!.data!.commit);
      return { plan, tests: s.steps.get("author-tests")!.outputs[0], taskStartSha: start, prevDone: prev.map((p) => p.step) };
    },
    async run(ctx) {
      const plan = requireOutput<Plan>(ctx.state, ctx.ledger, "plan");
      const spec = requireOutput<Spec>(ctx.state, ctx.ledger, "specify");
      const lock = requireOutput<Lock>(ctx.state, ctx.ledger, "author-tests");
      const baselineSha = ctx.state.steps.get("discover")!.outputs[0]!;
      const task = plan.tasks.find((t) => t.id === taskId)!;
      const inputs = implementStep(taskId).inputs(ctx.state, ctx.ledger)!;
      const start = String(inputs.taskStartSha);
      const wt = await ensureWorktree(ctx, start);
      // fresh attempt from a clean commit; the previous attempt's diff is saved first
      if ((await headSha(wt)) !== start || (await git(wt, ["status", "--porcelain"])).stdout.trim()) {
        const saved = ctx.ledger.putArtifact(await diffIncludingUntracked(wt, start));
        ctx.log(`implement ${taskId}: saved previous attempt's diff (${saved.slice(0, 8)}) and reset`);
        await resetHard(wt, start);
      }
      const { model, effort } = modelFor(ctx.project, "implement", ctx.rung);
      const acIds = acIdsFor(spec, task.reqs);
      const myTests = lock.tests.filter((t) => acIds.includes(t.acId));
      const rt = runtime();
      await ensureEgress(rt, feedHostsFrom(ctx.policy.registryAllowlist));
      await ensureAgentImage(rt, ctx.project.dotnet.sdkImage);
      const pack = buildPack({
        stage: "implement", cls: "agent", model, recipeVersion: "1", tools: [], redactor: new Redactor(),
        sections: [
          S.template("tpl", `You implement one task of an approved plan in an existing .NET codebase.
- Change only files in the task's file scope. Edits elsewhere are blocked.
- Tests are locked: don't edit or delete them, don't skip them, don't add #pragma or suppressions.
- No new packages unless the plan lists them. No git (the factory commits).
- Follow the exemplar files' style. Keep the change small.
- You may run "dotnet build" and unit tests that need no database. The factory runs the full checks after you finish.`),
          S.artifact("task", "plan-task", { ...task, approach: task.approach }),
          S.artifact("acs", "acceptance-criteria", spec.requirements.filter((r) => task.reqs.includes(r.id))),
          S.artifact("tests", "locked-tests", myTests),
          S.pointers([...task.fileScope.map((p) => ({ path: p, reason: "you may change this" })), ...task.exemplars.map((p) => ({ path: p, reason: "follow this style" })), ...myTests.map((t) => ({ path: t.file, reason: `locked test for ${t.acId}; read, don't edit` }))]),
          ...(ctx.priorFailures.length ? [{ spec: { id: "failures", source: "feedback" as const, trust: "derived" as const, placement: "user" as const }, content: ctx.priorFailures.slice(0, 20).map((f) => `- [${f.check}] ${f.message}${f.frames.length ? `\n    ${f.frames.join("\n    ")}` : ""}`).join("\n") }] : []),
          S.task(`Implement ${task.id}: ${task.title}.${ctx.priorFailures.length ? " The previous attempt failed; the failures are above." : ""}`),
          S.recap(["only the file scope", "don't touch tests", "no new packages", "return done=true when finished"]),
        ],
      });
      const r = await new ClaudeAgentRunner(rt, {
        runId: ctx.runId, key: `${key}/${ctx.attempt}`, fileScope: task.fileScope, lockedFiles: lock.lock.map((l) => l.file),
        extraProtected: [], packagesDir: packagesDir(ctx.runId), agentEnv: ctx.project.agentEnv,
        onContainer: async (id) => { await ctx.ledger.append({ type: "container.started", key, data: { id, role: "agent" } }, ctx.writer); },
        onRemoved: async (id) => { await ctx.ledger.append({ type: "container.removed", key, data: { id } }, ctx.writer); },
      }).run({ step: "implement", model, effort, pack, schema: ImplementOut, limits: { maxTurns: 80, maxUsd: 4, timeoutSec: 45 * 60 }, workdir: wt });
      await ctx.usage({ model, inputTokens: r.usage.inputTokens, outputTokens: r.usage.outputTokens, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite, turns: r.usage.turns, wallMs: r.usage.wallMs, estUsd: r.usage.estUsd });
      if (r.status !== "ok") return { kind: "fail", category: r.status === "rate-limited" ? "rate-limit" : "other", failures: [failure(`agent-${r.status}`, r.error ?? r.status)], signature: `implement:${r.status}` };

      // core commits (the agent has no git), then the producer judges that exact commit
      const commit = await commitAll(wt, `factory: ${task.id} ${task.title}`);
      const diff = await diffSummary(wt, start, commit, lock);
      const diffSha = ctx.ledger.putJson(diff);
      const baseline = ctx.ledger.getJson<TestRun>(baselineSha);
      const produced = await produce(ctx, `${key}/${ctx.attempt}`, commit, "task", {
        expectPass: myTests.map((t) => t.testId), expectFail: [], compareToBaseline: baseline.results.map((b) => b.id),
      });
      const run = storeRun(ctx, produced);
      const gated = await gateAll(ctx, key, commit, [
        [diffInScope, { diff: diffSha, task: ctx.ledger.putJson({ fileScope: task.fileScope }) }],
        [lockSetUnchanged, { diff: diffSha, tests: ctx.state.steps.get("author-tests")!.outputs[0]! }],
        [configIntegrity, { diff: diffSha, plan: ctx.state.steps.get("plan")!.outputs[0]! }],
        [noEscapeHatches, { diff: diffSha }],
        [noSecrets, { scan: ctx.ledger.putJson(secretScanOf(diff, commit)) }],
        [testExpectations, { run: run.testRun, baseline: baselineSha }],
      ]);
      if (gated) {
        if (!produced.build.ok) gated.failures.unshift(...produced.build.errors.slice(0, 10).map((e) => failure("build", `${e.file}:${e.line} ${e.code} ${e.msg}`)));
        return { kind: "fail", category: gated.category, failures: gated.failures.slice(0, 20), signature: failureSignature(gated.failures.map((f) => `${f.check}:${f.testId ?? f.message}`)), diffSha: sha256(JSON.stringify(diff.files)), lockedFailedIds: gated.lockedFailedIds };
      }
      return { kind: "done", outputs: { diff: diffSha, testRun: run.testRun }, treeSha: commit, data: { commit } };
    },
  };
}

// ---------- integrate (D) ----------
export const integrateStep: StepDef = {
  key: "integrate", stage: "integrate", templateVersion: "1", coding: true,
  inputs: (s) => {
    const plan = s.steps.get("plan");
    if (plan?.status !== "completed") return undefined;
    const tasks = [...s.steps.values()].filter((r) => r.step.startsWith("implement/"));
    const taskCount = (s.steps.get("plan")!.data?.taskCount as number | undefined);
    if (!tasks.length || tasks.some((t) => t.status !== "completed") || (taskCount && tasks.length < taskCount)) return undefined;
    return { head: tasks[tasks.length - 1]!.data?.commit, tests: s.steps.get("author-tests")!.outputs[0] };
  },
  async run(ctx) {
    const lock = requireOutput<Lock>(ctx.state, ctx.ledger, "author-tests");
    const baselineSha = ctx.state.steps.get("discover")!.outputs[0]!;
    const baseline = ctx.ledger.getJson<TestRun>(baselineSha);
    const head = String(integrateStep.inputs(ctx.state, ctx.ledger)!.head);
    const wt = await ensureWorktree(ctx, head);
    const diff = await diffSummary(wt, ctx.state.info.baseCommit!, head, lock);
    const diffSha = ctx.ledger.putJson(diff);
    const produced = await produce(ctx, "integrate", head, "integrate", {
      expectPass: [...lock.tests.map((t) => t.testId), ...lock.characterisation.map((c) => c.testId)],
      expectFail: [], compareToBaseline: baseline.results.map((b) => b.id),
    });
    const run = storeRun(ctx, produced);
    const gated = await gateAll(ctx, "integrate", head, [
      [testExpectations, { run: run.testRun, baseline: baselineSha }],
      [lockSetUnchanged, { diff: diffSha, tests: ctx.state.steps.get("author-tests")!.outputs[0]! }],
      [diffSize, { diff: diffSha }],
    ]);
    if (gated) return { kind: "park", reason: `Integration failed: ${gated.failures.slice(0, 3).map((f) => f.message).join("; ")}` };
    return { kind: "done", outputs: { testRun: run.testRun, diff: diffSha }, treeSha: head, data: { commit: head } };
  },
};

// ---------- accept (D) ----------
// POC: evidence per AC is its locked test passing in the integrate run (kind from the AC level).
// Booting the app and replaying HTTP/UI with recorded evidence (verify-runner §2.8) comes next.
export const acceptStep: StepDef = {
  key: "accept", stage: "accept", templateVersion: "1",
  inputs: (s) => (s.steps.get("integrate")?.status === "completed" ? { integrate: s.steps.get("integrate")!.outputs[0] } : undefined),
  async run(ctx): Promise<StepOutcome> {
    const spec = requireOutput<Spec>(ctx.state, ctx.ledger, "specify");
    const lock = requireOutput<Lock>(ctx.state, ctx.ledger, "author-tests");
    const run = requireOutput<TestRun>(ctx.state, ctx.ledger, "integrate");
    const passed = new Set(run.results.filter((r) => r.outcome === "passed" && !r.flaky).map((r) => r.id));
    const items = spec.requirements.flatMap((r) => r.acceptance.map((a) => {
      const t = lock.tests.find((x) => x.acId === a.id);
      return { acId: a.id, kind: a.level === "manual" ? "manual" : a.level === "ui" ? "screenshot" : a.level === "job" ? "job" : "http", testId: t?.testId, passed: a.level === "manual" ? false : !!t && passed.has(t.testId) };
    }));
    const missing = items.filter((i) => i.kind !== "manual" && !i.passed);
    if (missing.length) return { kind: "park", reason: `No passing evidence for ${missing.map((m) => m.acId).join(", ")}` };
    const manual = items.filter((i) => i.kind === "manual");
    const sha = ctx.ledger.putJson({ header: header(ctx.runId, "acceptance-evidence", "accept", ""), items, note: "Evidence = the locked AC test passing in the integrate run. App boot + HTTP replay not built yet.", manualPending: manual.map((m) => m.acId) });
    return { kind: "done", outputs: { evidence: sha } };
  },
};
