// Build side of the brownfield slice (stages-aligned §1): discover/baseline → stub commit →
// author-tests (fails on base twice → lock) → implement ⟲ task verify → integrate → accept.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
import { produceDotnetTests, type Probe, type ProduceOutput } from "../verify/dotnet.js";
import type { Expectations } from "../verify/validate.js";
import { header, requireOutput, type StepContext, type StepDef, type StepOutcome } from "./framework.js";
import { modelFor } from "./routing.js";
import { family } from "../runners/types.js";
import { S } from "./think.js";
import { ensureWorktree, runtime, snapshotFor } from "./workspace.js";

type Plan = z.infer<typeof PlanBody> & { complexity: string };
type Spec = z.infer<typeof SpecDraft>;

interface Lock {
  tests: { acId: string; file: string; name: string; testId: string }[];
  characterisation: { target: string; file: string; testId: string }[];
  lock: { file: string; sha: string }[];
  probes?: Probe[];
}

const packagesDir = (runId: string) => {
  const d = join(factoryHome(), "tmp", runId, "nuget");
  mkdirSync(d, { recursive: true });
  return d;
};

async function produce(ctx: StepContext, key: string, commit: string, stage: TestRun["stage"], exp: Expectations, onlyTests?: string[], filterExpr?: string, accept?: { probes: Probe[] }): Promise<ProduceOutput> {
  const rt = runtime();
  await ensureEgress(rt, feedHostsFrom(ctx.policy.registryAllowlist));
  return produceDotnetTests({
    runId: ctx.runId, key, repo: ctx.state.info.repoPath!, commit, stage, exp, project: ctx.project, rt, onlyTests, filterExpr, accept,
    packagesDir: packagesDir(ctx.runId),
    onContainer: async (id, role) => { await ctx.ledger.append({ type: "container.started", key, data: { id, role } }, ctx.writer); },
    onRemoved: async (id) => { await ctx.ledger.append({ type: "container.removed", key, data: { id } }, ctx.writer); },
  });
}

/**
 * The coding container reads restored packages from the run's package folder (read-only, no network).
 * If discover reused a cached baseline, nothing restored them yet for this run: do it now.
 */
async function ensurePackages(ctx: StepContext, commit: string): Promise<void> {
  const dir = packagesDir(ctx.runId);
  if (readdirSync(dir).length) return;
  ctx.log("restoring packages for the coding container");
  const out = await produceDotnetTests({
    runId: ctx.runId, key: "restore", repo: ctx.state.info.repoPath!, commit, stage: "task",
    exp: { expectPass: [], expectFail: [], compareToBaseline: [] }, project: ctx.project, rt: runtime(), packagesDir: dir, restoreOnly: true,
    onContainer: async (id, role) => { await ctx.ledger.append({ type: "container.started", key: "restore", data: { id, role } }, ctx.writer); },
    onRemoved: async (id) => { await ctx.ledger.append({ type: "container.removed", key: "restore", data: { id } }, ctx.writer); },
  });
  if (!out.build.ok) throw new Error(`Package restore failed: ${out.logs.restore.split("\n").slice(-5).join(" ")}`);
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
  tests: z.array(z.object({ acId: z.string(), file: z.string(), name: z.string().regex(/^AC_\d+_\d+_\w+$/, "method name must be AC_<req>_<n>_<Words>") })).min(1),
  characterisation: z.array(z.object({ target: z.string(), file: z.string(), name: z.string().regex(/^CHAR_\w+$/, "method name must be CHAR_<Words>") })),
  /** one HTTP request per api-level criterion, replayed against the running app at accept */
  probes: z.array(z.object({
    acId: z.string(), method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]), path: z.string().startsWith("/"),
    body: z.string().optional(), expectStatus: z.number().int().min(100).max(599),
  })).default([]),
  notes: z.string(),
});

/**
 * The test author gives method names; the factory finds the real test IDs from a run
 * (project::Namespace.Class.Method(args)), so nobody has to guess the ID format.
 * A theory can have several rows: all of them count.
 */
export function resolveTestIds(names: string[], resultIds: string[]): { ids: Record<string, string[]>; missing: string[] } {
  const ids: Record<string, string[]> = {};
  const missing: string[] = [];
  for (const n of names) {
    const hits = resultIds.filter((id) => id.replace(/\(.*$/, "").endsWith(`.${n}`));
    if (hits.length) ids[n] = hits;
    else missing.push(n);
  }
  return { ids, missing };
}

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
    await ensurePackages(ctx, start);
    // The test author sees ACs, stub signatures and harness rules. Never the plan's approach.
    const acs = spec.requirements.flatMap((r) => r.acceptance.map((a) => ({ req: r.id, ...a })));
    const pack = buildPack({
      stage: "author-tests", cls: "agent", model, recipeVersion: "1", tools: [], redactor: new Redactor(),
      sections: [
        S.template("tpl", `You write black-box acceptance tests for a .NET service, one test per acceptance criterion, before the feature exists.
Rules:
- Put tests in the existing test project that best fits (look for *Tests.csproj). Follow the style of existing tests there (xUnit, WebApplicationFactory if used).
- Test through public surfaces only: HTTP endpoints, public service methods, database rows. Don't test private code.
- Name each acceptance test method exactly AC_<req>_<n>_<Words> for acceptance criterion AC-<req>.<n>, e.g. AC_1_2_Returns404WhenOrderMissing. Name characterisation test methods CHAR_<Words>. The factory finds tests by these names.
- New APIs exist as stubs that throw NotImplementedException; tests must compile against them and fail for now.
- Also write characterisation tests for existing behaviour next to the change that must NOT change; those must pass today.
- Don't change production code. Don't change test project files unless a package reference is missing and already restored.
- You may run "dotnet build" to check the tests compile. There's no database in this container; don't try to make tests pass.
- For each "api" criterion whose endpoint needs NO login, also give one HTTP probe: method, path, optional JSON body, and the status code the criterion expects once implemented. The factory sends it to the running app (with an empty test database) as evidence. Skip criteria that need a login or seeded data.
Return the list of tests you wrote (acId, file, method name) and the probes.`),
        S.artifact("acs", "acceptance-criteria", acs),
        S.artifact("stubs", "stubs", plan.stubs.map((s) => ({ path: s.path, content: s.content }))),
        ...(ctx.priorFailures.length ? [{ spec: { id: "failures", source: "feedback" as const, trust: "derived" as const, placement: "user" as const }, content: "Your previous attempt was rejected:\n" + ctx.priorFailures.slice(0, 20).map((f) => `- [${f.check}] ${f.message}`).join("\n") }] : []),
        S.task(`Write the acceptance and characterisation tests now.${ctx.priorFailures.length ? " The previous attempt failed for the reasons above; fix them." : ""}`),
        S.recap(["one test per AC", "tests fail now for the right reason", "characterisation tests pass today", "don't touch production code"]),
      ],
    });
    const r = await new ClaudeAgentRunner(rt, {
      runId: ctx.runId, key: `author-tests/${ctx.attempt}`, fileScope: TEST_SCOPE, lockedFiles: [], extraProtected: [],
      protectedGlobs: CONFIG_INTEGRITY_GLOBS, packagesDir: packagesDir(ctx.runId), agentEnv: ctx.project.agentEnv, noGo: ctx.project.noGo,
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

    // find the real test IDs by method name (one quick run, no expectations)
    const names = [...out.tests.map((t) => t.name), ...out.characterisation.map((c) => c.name)];
    ctx.log("author-tests: finding the new tests");
    const found = await produce(ctx, "author-tests/find", commit, "author-tests-on-base", { expectPass: [], expectFail: [], compareToBaseline: [] }, undefined,
      names.map((n) => `FullyQualifiedName~.${n}`).join("|"));
    const { ids, missing } = resolveTestIds(names, found.testRun.results.map((r) => r.id));
    if (!found.build.ok || missing.length) {
      await resetHard(wt, start);
      const why = !found.build.ok
        ? found.build.errors.slice(0, 10).map((e) => failure("tests-compile", `${e.file}:${e.line} ${e.code} ${e.msg}`))
        : missing.map((n) => failure("test-not-found", `No test method named ${n} ran. Is it public, in a test project, and marked [Fact]/[Theory]?`));
      return { kind: "fail", category: "other", failures: why, signature: `author-tests:${!found.build.ok ? "compile" : "not-found"}` };
    }
    const tests = out.tests.flatMap((t) => ids[t.name]!.map((testId) => ({ ...t, testId, failsOnBase: true })));
    const characterisation = out.characterisation.flatMap((c) => ids[c.name]!.map((testId) => ({ ...c, testId, passesOnBase: true })));
    const exp: Expectations = {
      expectPass: characterisation.map((c) => c.testId),
      expectFail: tests.map((t) => ({ id: t.testId, kinds: ["assertion", "not-implemented"] })),
      compareToBaseline: [],
    };
    const only = [...tests.map((t) => t.testId), ...characterisation.map((c) => c.testId)];
    ctx.log("author-tests: running the new tests on the old code, twice");
    const run1 = storeRun(ctx, await produce(ctx, "author-tests/base-1", commit, "author-tests-on-base", exp, only));
    const run2 = storeRun(ctx, await produce(ctx, "author-tests/base-2", commit, "author-tests-on-base", exp, only));
    const acIds = new Set(acs.filter((a) => a.level === "api").map((a) => a.id));
    const lock: Lock = {
      tests, characterisation, probes: out.probes.filter((p) => acIds.has(p.acId)),
      lock: changed.filter((c) => c.status !== "D").map((c) => ({ file: c.path, sha: sha256(readFileSync(join(wt, c.path))) })),
    };
    // design allows one family until a second vendor's coding runner exists; say so in the evidence
    const implementer = modelFor(ctx.project, "implement", 0).model;
    const families = { testAuthor: family(model), implementer: family(implementer) };
    const familyNote = families.testAuthor === families.implementer
      ? `Single model family: tests written by ${model}, code by ${implementer} (both ${families.testAuthor}). A second-vendor coding runner isn't built yet.`
      : undefined;
    const lockSha = ctx.ledger.putJson({ ...lock, unlocks: [], families, familyNote, header: header(ctx.runId, "acceptance-tests", "author-tests", "", model) });
    const g = await runGate(failsOnBase, ctx.ledger, ctx.writer, { run1: run1.testRun, run2: run2.testRun, tests: lockSha }, ctx.policy, { step: "author-tests", treeSha: commit });
    if (!g.passed) {
      await resetHard(wt, start);
      return { kind: "fail", category: "other", failures: g.failures ?? [], signature: failureSignature((g.failures ?? []).map((f) => f.message)) };
    }
    return { kind: "done", outputs: { tests: lockSha, run1: run1.testRun, run2: run2.testRun }, treeSha: commit, data: { commit, locked: lock.lock.length, familyNote } };
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

/**
 * Each acceptance criterion belongs to exactly one task: the LAST task (in plan order) that works on
 * its requirement. Earlier tasks that touch the same requirement build towards it but aren't held to
 * its tests yet, so a requirement split over two tasks doesn't make task 1 impossible.
 */
export function acOwners(plan: { tasks: { id: string; reqs: string[] }[] }, spec: Pick<Spec, "requirements">): Map<string, string> {
  const owners = new Map<string, string>();
  for (const r of spec.requirements) {
    const owner = [...plan.tasks].reverse().find((t) => t.reqs.includes(r.id));
    if (owner) for (const a of r.acceptance) owners.set(a.id, owner.id);
  }
  return owners;
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
      const owners = acOwners(plan, spec);
      const myTests = lock.tests.filter((t) => owners.get(t.acId) === task.id);
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
        extraProtected: [], packagesDir: packagesDir(ctx.runId), agentEnv: ctx.project.agentEnv, noGo: ctx.project.noGo,
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
      const failed = (g: NonNullable<Awaited<ReturnType<typeof gateAll>>>) =>
        ({ kind: "fail" as const, category: g.category, failures: g.failures.slice(0, 20), signature: failureSignature(g.failures.map((f) => `${f.check}:${f.testId ?? f.message}`)), diffSha: sha256(JSON.stringify(diff.files)), lockedFailedIds: g.lockedFailedIds });
      // 1. the diff checks first: a change that touches locked tests, protected files or secrets never gets run
      const diffGated = await gateAll(ctx, key, commit, [
        [lockSetUnchanged, { diff: diffSha, tests: ctx.state.steps.get("author-tests")!.outputs[0]! }],
        [configIntegrity, { diff: diffSha, plan: ctx.state.steps.get("plan")!.outputs[0]! }],
        [noSecrets, { scan: ctx.ledger.putJson(secretScanOf(diff, commit)) }],
        [diffInScope, { diff: diffSha, task: ctx.ledger.putJson({ fileScope: task.fileScope }) }],
        [noEscapeHatches, { diff: diffSha }],
      ]);
      if (diffGated) return failed(diffGated);
      // 2. only then build and run the tests on that exact commit
      const produced = await produce(ctx, `${key}/${ctx.attempt}`, commit, "task", {
        // must pass: this task's own criteria + the characterisation tests (behaviour that must not change)
        expectPass: [...myTests.map((t) => t.testId), ...lock.characterisation.map((c) => c.testId)],
        expectFail: [], compareToBaseline: baseline.results.map((b) => b.id),
      });
      const run = storeRun(ctx, produced);
      const gated = await gateAll(ctx, key, commit, [[testExpectations, { run: run.testRun, baseline: baselineSha }]]);
      if (gated) {
        if (!produced.build.ok) gated.failures.unshift(...produced.build.errors.slice(0, 10).map((e) => failure("build", `${e.file}:${e.line} ${e.code} ${e.msg}`)));
        return failed(gated);
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

// ---------- accept (D, no model) ----------
// Boot the app next to the test Postgres, send the locked HTTP probes, re-run the locked criteria tests;
// every criterion gets evidence of its kind (verify-runner §2.8, minimal: no login/identities yet).
export const acceptStep: StepDef = {
  key: "accept", stage: "accept", templateVersion: "2",
  inputs: (s) => (s.steps.get("integrate")?.status === "completed" ? { integrate: s.steps.get("integrate")!.outputs[0], head: s.steps.get("integrate")!.data?.commit } : undefined),
  async run(ctx): Promise<StepOutcome> {
    const spec = requireOutput<Spec>(ctx.state, ctx.ledger, "specify");
    const lock = requireOutput<Lock>(ctx.state, ctx.ledger, "author-tests");
    const head = String(ctx.state.steps.get("integrate")!.data!.commit);
    const probes = lock.probes ?? [];
    ctx.log(`accept: booting the app and sending ${probes.length} probe(s)`);
    const out = await produce(ctx, "accept", head, "accept", { expectPass: lock.tests.map((t) => t.testId), expectFail: [], compareToBaseline: [] },
      lock.tests.map((t) => t.testId), undefined, { probes });
    const runSha = storeRun(ctx, out).testRun;
    const acc = out.accept ?? { boot: { attempted: false, ok: false, note: "not run", logTail: "" }, probes: [] };
    const bootLog = ctx.ledger.putArtifact(acc.boot.logTail);
    const passed = new Set(out.testRun.results.filter((r) => r.outcome === "passed" && !r.flaky).map((r) => r.id));
    const items = spec.requirements.flatMap((r) => r.acceptance.map((a) => {
      const tests = lock.tests.filter((t) => t.acId === a.id);
      const http = acc.probes.filter((p) => p.acId === a.id).map((p) => ({
        method: p.method, path: p.path, status: p.status, expectStatus: p.expectStatus,
        requestSha: p.requestBody !== undefined ? ctx.ledger.putArtifact(p.requestBody) : undefined,
        bodySha: ctx.ledger.putArtifact(p.responseBody),
      }));
      const kind = a.level === "manual" ? "manual" : a.level === "ui" ? "ui" : a.level === "job" ? "job" : "http";
      const testsOk = tests.length > 0 && tests.every((t) => passed.has(t.testId));
      const probesOk = http.every((h) => h.status === h.expectStatus);
      return { ac: a.id, kind, testIds: tests.map((t) => t.testId), http, passed: kind === "manual" ? false : testsOk && probesOk };
    }));
    const evidence = {
      header: header(ctx.runId, "acceptance-evidence", "accept", ""), items,
      app: { ...acc.boot, logTail: undefined, logSha: bootLog },
      testRun: runSha,
      limits: "Probes cover only endpoints without login (test users/tokens aren't built yet).",
    };
    const sha = ctx.ledger.putJson(evidence);
    const problems = [
      ...(acc.boot.attempted && !acc.boot.ok ? [`the app didn't start: ${acc.boot.note ?? ""}`] : []),
      ...items.filter((i) => i.kind !== "manual" && !i.passed).map((i) => `${i.ac}: ${i.testIds.length ? "" : "no locked test; "}${i.http.filter((h) => h.status !== h.expectStatus).map((h) => `${h.method} ${h.path} answered ${h.status}, expected ${h.expectStatus}`).join("; ") || "locked test didn't pass"}`),
    ];
    if (problems.length) return { kind: "park", reason: `Acceptance evidence is missing: ${problems.join(" | ")}` };
    return { kind: "done", outputs: { evidence: sha, testRun: runSha }, data: { appStarted: acc.boot.ok, probes: acc.probes.length, manualPending: items.filter((i) => i.kind === "manual").map((i) => i.ac) } };
  },
};
