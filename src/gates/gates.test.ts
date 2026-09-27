import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AcceptanceTests, TestRun } from "../contracts/index.js";
import { HUMAN_WRITER, Ledger } from "../ledger/ledger.js";
import { matchesAny } from "../util/glob.js";
import {
  DEFAULT_POLICY, configIntegrity, diffInScope, evaluate, failsOnBase, isBlocking, isConfigIntegrityPath,
  isSecretPath, lockSetUnchanged, mergePolicy, nextOnFailure, noEscapeHatches, planChecks, runGate,
  testExpectations, verifyEvidence, type AttemptRecord, type DiffSummary, type LadderOptions, RUNGS,
} from "./index.js";

beforeEach(() => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-gates-"));
});

const sha = (c: string) => c.repeat(64);
const diff = (files: Partial<DiffSummary["files"][number]>[], lockedNow: DiffSummary["lockedNow"] = {}): DiffSummary => ({
  from: "a", to: "b", lockedNow,
  files: files.map((f) => ({ status: "M", path: "x", added: [], removed: [], ...f })),
});
const tests = (over: Partial<AcceptanceTests> = {}): AcceptanceTests => ({
  header: { kind: "acceptance-tests", schemaVersion: 1, runId: "r", producedBy: { stage: "author-tests" }, inputsHash: sha("0"), createdAt: "" },
  tests: [{ acId: "AC-1.1", file: "tests/ATests.cs", name: "A", testId: "T::A", failsOnBase: true }],
  characterisation: [], lock: [{ file: "tests/ATests.cs", sha: sha("1") }], unlocks: [], ...over,
});
const run = (results: TestRun["results"], over: Partial<TestRun> = {}): TestRun => ({
  kind: "test", treeSha: "f".repeat(40), stage: "task", runner: "vstest", toolVersions: {},
  expectPass: [], expectFail: [], compareToBaseline: [], discovered: results.map((r) => r.id),
  results, exitCode: 0, reportShas: [], valid: true, classification: "ok", ...over,
});

describe("globs", () => {
  it("matches at any depth and with **", () => {
    expect(matchesAny("src/Api/CLAUDE.md", ["**/CLAUDE*.md"])).toBe(true);
    expect(matchesAny("CLAUDE.md", ["**/CLAUDE*.md"])).toBe(true);
    expect(matchesAny("src/a.cs", ["src/**"])).toBe(true);
    expect(matchesAny("lib/a.cs", ["src/**"])).toBe(false);
    expect(matchesAny("a/b/.env", [".env"])).toBe(true);
    expect(matchesAny("src/Orders/OrderSync.cs", ["src/Orders/*.cs"])).toBe(true);
    expect(matchesAny("src/Orders/Deep/X.cs", ["src/Orders/*.cs"])).toBe(false);
  });

  it("knows protected and secret paths", () => {
    expect(isConfigIntegrityPath("sub/AGENTS.md")).toBe(true);
    expect(isConfigIntegrityPath("src/Data/Migrations/2026_Add.cs")).toBe(true);
    expect(isConfigIntegrityPath("src/Service.cs")).toBe(false);
    expect(isSecretPath("api/appsettings.Development.json")).toBe(true);
    expect(isSecretPath("api/appsettings.json")).toBe(false);
    expect(isSecretPath(".env.example")).toBe(false);
    expect(isSecretPath("web/.env.local")).toBe(true);
  });
});

describe("task gates", () => {
  it("diff in scope", () => {
    const ok = diffInScope.predicate({ diff: diff([{ path: "src/A.cs" }]), task: { fileScope: ["src/A.cs"] } }, DEFAULT_POLICY);
    expect(ok.passed).toBe(true);
    const bad = diffInScope.predicate({ diff: diff([{ path: "src/B.cs" }]), task: { fileScope: ["src/A.cs"] } }, DEFAULT_POLICY);
    expect(bad.passed).toBe(false);
  });

  it("locks tests by hash and test infrastructure by path", () => {
    expect(lockSetUnchanged.predicate({ diff: diff([], { "tests/ATests.cs": sha("1") }), tests: tests() }, DEFAULT_POLICY).passed).toBe(true);
    expect(lockSetUnchanged.predicate({ diff: diff([], { "tests/ATests.cs": sha("2") }), tests: tests() }, DEFAULT_POLICY).passed).toBe(false);
    expect(lockSetUnchanged.predicate({ diff: diff([], { "tests/ATests.cs": null }), tests: tests() }, DEFAULT_POLICY).details).toMatch(/Deleted/);
    const csproj = diff([{ path: "tests/Checkout.Tests/Checkout.Tests.csproj" }], { "tests/ATests.cs": sha("1") });
    expect(lockSetUnchanged.predicate({ diff: csproj, tests: tests() }, DEFAULT_POLICY).passed).toBe(false);
  });

  it("config integrity allows only declared protected paths", () => {
    const d = diff([{ path: "src/Data/Migrations/1_Add.cs" }]);
    expect(configIntegrity.predicate({ diff: d, plan: { protectedPathsDeclared: [] } }, DEFAULT_POLICY).passed).toBe(false);
    expect(configIntegrity.predicate({ diff: d, plan: { protectedPathsDeclared: ["src/Data/Migrations/**"] } }, DEFAULT_POLICY).passed).toBe(true);
  });

  it("finds escape hatches in added lines only", () => {
    const d = diff([{ path: "src/A.cs", added: ['    [Fact(Skip = "later")]', "#pragma warning disable CS0168"], removed: ["// eslint-disable"] }]);
    const v = noEscapeHatches.predicate({ diff: d }, DEFAULT_POLICY);
    expect(v.failures).toHaveLength(2);
    expect(noEscapeHatches.predicate({ diff: diff([{ path: "a.ts", added: ["it.only('x', () => {})"] }]) }, DEFAULT_POLICY).passed).toBe(false);
    expect(noEscapeHatches.predicate({ diff: diff([{ path: "a.ts", added: ["const expected = 1;"] }]) }, DEFAULT_POLICY).passed).toBe(true);
  });
});

describe("test gates", () => {
  it("locked tests must run and pass first time", () => {
    const passed = run([{ id: "T::A", outcome: "passed", durationMs: 1 }], { expectPass: ["T::A"] });
    expect(testExpectations.predicate({ run: passed }, DEFAULT_POLICY).passed).toBe(true);
    const missing = run([], { expectPass: ["T::A"] });
    expect(testExpectations.predicate({ run: missing }, DEFAULT_POLICY).details).toMatch(/didn't run/);
    const flaky = run([{ id: "T::A", outcome: "passed", durationMs: 1, flaky: true }], { expectPass: ["T::A"] });
    expect(testExpectations.predicate({ run: flaky }, DEFAULT_POLICY).passed).toBe(false);
    const invalid = run([], { valid: false, invalidReason: "report missing" });
    expect(testExpectations.predicate({ run: invalid }, DEFAULT_POLICY).passed).toBe(false);
  });

  it("no new failures vs baseline", () => {
    const base = run([{ id: "U::Old", outcome: "failed", durationMs: 1 }]);
    const now = run([{ id: "U::Old", outcome: "failed", durationMs: 1 }, { id: "U::New", outcome: "failed", durationMs: 1 }], { compareToBaseline: ["U::Old", "U::New"] });
    const v = testExpectations.predicate({ run: now, baseline: base }, DEFAULT_POLICY);
    expect(v.failures?.map((f) => f.testId)).toEqual(["U::New"]);
  });

  it("AC tests must fail on base with assertion or not-implemented, twice", () => {
    const good = run([{ id: "T::A", outcome: "failed", failureKind: "not-implemented", durationMs: 1 }]);
    expect(failsOnBase.predicate({ run1: good, run2: good, tests: tests() }, DEFAULT_POLICY).passed).toBe(true);
    const compile = run([{ id: "T::A", outcome: "failed", failureKind: "compile", durationMs: 1 }]);
    expect(failsOnBase.predicate({ run1: good, run2: compile, tests: tests() }, DEFAULT_POLICY).passed).toBe(false);
    const passes = run([{ id: "T::A", outcome: "passed", durationMs: 1 }]);
    expect(failsOnBase.predicate({ run1: passes, run2: passes, tests: tests() }, DEFAULT_POLICY).details).toMatch(/already passes/);
  });
});

describe("plan and review gates", () => {
  const spec = { requirements: [{ id: "REQ-1", ears: "", op: "ADDED" as const, sources: [], acceptance: [] }, { id: "REQ-2", ears: "", op: "ADDED" as const, sources: [], acceptance: [] }], nfrs: [], outOfScope: [], assumptions: [] };
  const task = (id: string, reqs: string[], fileScope: string[]) => ({ id, title: id, reqs, fileScope, exemplars: [], conventions: [], dependsOn: [], plannedLoc: 10, approach: "" });
  const plan = (tasks: ReturnType<typeof task>[]) => ({
    header: tests().header, tasks, options: [{ id: "O-1", summary: "", simplest: true, tradeoffs: "" }, { id: "O-2", summary: "", simplest: false, tradeoffs: "" }],
    chosen: "O-1", adr: "Use O-1", protectedPathsDeclared: [], newDependencies: [], stubs: [], complexity: "S" as const,
  });

  it("plan covers every REQ and scopes don't overlap", () => {
    expect(planChecks.predicate({ plan: plan([task("TASK-1", ["REQ-1"], ["a.cs"]), task("TASK-2", ["REQ-2"], ["b.cs"])]), spec }, DEFAULT_POLICY).passed).toBe(true);
    const v = planChecks.predicate({ plan: plan([task("TASK-1", ["REQ-1"], ["src/**"]), task("TASK-2", ["REQ-1"], ["src/b.cs"])]), spec }, DEFAULT_POLICY);
    expect(v.failures?.map((f) => f.check).sort()).toEqual(["plan-coverage", "plan-scope-overlap"]);
  });

  it("review blocking is derived by code", () => {
    const f = { id: "R-1", category: "correctness" as const, file: "a", line: 1, text: "", confidence: 0.9, severity: "high" as const };
    expect(isBlocking(f, DEFAULT_POLICY)).toBe(true);
    expect(isBlocking({ ...f, confidence: 0.5 }, DEFAULT_POLICY)).toBe(false);
    expect(isBlocking({ ...f, category: "reuse" }, DEFAULT_POLICY)).toBe(false);
    expect(isBlocking({ ...f, category: "security", severity: "medium" }, DEFAULT_POLICY)).toBe(true);
  });
});

describe("policy merge", () => {
  it("only gets stricter", () => {
    const p = mergePolicy(DEFAULT_POLICY, { allowedModels: ["claude-sonnet-5", "claude-opus-5-5"], maxDiffLines: 400 }, { allowedModels: ["claude-opus-5-5", "gpt-x"], maxDiffLines: 9000, localOnly: true, protectedPaths: ["infra/**"] });
    expect(p.allowedModels).toEqual(["claude-opus-5-5"]);
    expect(p.maxDiffLines).toBe(400);
    expect(p.localOnly).toBe(true);
    expect(p.protectedPaths).toEqual(["infra/**"]);
    expect(mergePolicy(p, { localOnly: false }).localOnly).toBe(true);
  });
});

describe("failure ladder", () => {
  const opts = (over: Partial<LadderOptions> = {}): LadderOptions => ({
    maxAttempts: 6, attemptsPerRung: 2, availableRungs: new Set(RUNGS), backoffSpentMs: 0, backoffCapMs: 900_000, a5Done: new Set(), ...over,
  });
  const a = (over: Partial<AttemptRecord>): AttemptRecord => ({ category: "other", signature: "s", rung: 0, ...over });

  it("safety: retry once, then park", () => {
    expect(nextOnFailure([a({ category: "safety" })], opts()).action).toBe("retry");
    expect(nextOnFailure([a({ category: "safety" }), a({ category: "safety" })], opts()).action).toBe("park");
  });

  it("same locked test twice → A5 check", () => {
    const h = [a({ category: "locked-test", lockedFailedIds: ["T::A"], signature: "x" }), a({ category: "locked-test", lockedFailedIds: ["T::A"], signature: "y" })];
    expect(nextOnFailure(h, opts())).toMatchObject({ action: "a5-check", testIds: ["T::A"] });
    expect(nextOnFailure(h, opts({ a5Done: new Set(["T::A"]) })).action).toBe("retry");
  });

  it("same signature skips to the next rung; missing rungs are skipped", () => {
    expect(nextOnFailure([a({ signature: "x" })], opts())).toMatchObject({ action: "retry", rung: 0 });
    expect(nextOnFailure([a({ signature: "x" }), a({ signature: "x" })], opts())).toMatchObject({ action: "retry", rung: 1 });
    const noVendor = opts({ availableRungs: new Set(["retry", "raise-effort", "stronger-model"]) });
    expect(nextOnFailure([a({ rung: 2, signature: "p" }), a({ rung: 2, signature: "q" })], noVendor).action).toBe("park");
  });

  it("parks at 6 attempts and backs off on rate limits", () => {
    const six = Array.from({ length: 6 }, (_, i) => a({ signature: `s${i}` }));
    expect(nextOnFailure(six, opts()).action).toBe("park");
    expect(nextOnFailure([a({ category: "rate-limit" })], opts()).action).toBe("backoff");
    expect(nextOnFailure([a({ category: "rate-limit" })], opts({ backoffSpentMs: 900_000 })).action).toBe("park");
  });
});

describe("recorded gates can be re-checked", () => {
  it("verify-evidence re-runs predicates from the ledger", async () => {
    const l = Ledger.create("run-g");
    await l.append({ type: "run.created", data: { mode: "brownfield", project: "p" } }, HUMAN_WRITER);
    const d = l.putJson(diff([{ path: "src/A.cs" }]));
    const t = l.putJson({ fileScope: ["src/A.cs"] });
    const r = await runGate(diffInScope, l, HUMAN_WRITER, { diff: d, task: t }, DEFAULT_POLICY, { step: "implement/TASK-1" });
    expect(r.passed).toBe(true);
    expect(evaluate(diffInScope, l, { diff: d, task: t }, DEFAULT_POLICY).inputsHash).toBe(r.inputsHash);
    expect(verifyEvidence(l).every((c) => c.ok)).toBe(true);
    writeFileSync(join(l.artifactsDir, d), JSON.stringify(diff([{ path: "src/B.cs" }])));
    expect(verifyEvidence(l).some((c) => !c.ok)).toBe(true);
  });
});
