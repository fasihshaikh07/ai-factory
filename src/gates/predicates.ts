// The POC gates (gate-engine §2.5). Each reads ledger artifacts only.
import type {
  AcceptanceTests, CurrentBehaviour, Failure, Plan, ReviewFinding, SecretScan, SpecDraft, TestRun,
} from "../contracts/index.js";
import { matchesAny } from "../util/glob.js";
import { defineGate, failure, verdict } from "./engine.js";
import type { Policy } from "./policy.js";
import { isConfigIntegrityPath, isLockSetPath } from "./protected.js";

// ---------- shared producer outputs (computed by the core, stored in the ledger) ----------

/** What a commit changed, relative to the task's start. */
export interface DiffSummary {
  from: string;
  to: string;
  files: { status: string; path: string; added: string[]; removed: string[] }[];
  /** sha256 of each locked file at `to` (missing = deleted). */
  lockedNow: Record<string, string | null>;
}

// ---------- task verify ----------

export const diffInScope = defineGate<{ diff: DiffSummary; task: { fileScope: string[] } }>({
  id: "task.diff-in-scope", after: "implement", safety: false, waiver: "none",
  predicate: ({ diff, task }) => verdict(
    diff.files
      .filter((f) => !matchesAny(f.path, task.fileScope))
      .map((f) => failure("diff-in-scope", `Changed ${f.path}, which is outside the task's file scope`, { location: f.path })),
    "All changes are inside the task's file scope",
  ),
});

export const lockSetUnchanged = defineGate<{ diff: DiffSummary; tests: AcceptanceTests }>({
  id: "task.lock-set-unchanged", after: "implement", safety: true, waiver: "none",
  predicate: ({ diff, tests }) => {
    const lockedFiles = tests.lock.map((l) => l.file);
    const fs: Failure[] = [];
    for (const l of tests.lock) {
      const now = diff.lockedNow[l.file];
      if (now !== l.sha) fs.push(failure("lock-set", now === null ? `Deleted locked test file ${l.file}` : `Changed locked test file ${l.file}`, { location: l.file }));
    }
    for (const f of diff.files) {
      if (!lockedFiles.includes(f.path) && isLockSetPath(f.path)) {
        fs.push(failure("lock-set", `Changed test infrastructure ${f.path}`, { location: f.path }));
      }
      if (/\.sln$/.test(f.path) && [...f.added, ...f.removed].some((l) => /Test/i.test(l))) {
        fs.push(failure("lock-set", `Changed test project entries in ${f.path}`, { location: f.path }));
      }
    }
    return verdict(fs, "Locked tests and test infrastructure unchanged");
  },
});

export const configIntegrity = defineGate<{ diff: DiffSummary; plan: Pick<Plan, "protectedPathsDeclared"> }>({
  id: "task.config-integrity", after: "implement", safety: true, waiver: "none",
  predicate: ({ diff, plan }, policy: Policy) => verdict(
    diff.files
      .filter((f) => isConfigIntegrityPath(f.path, policy.protectedPaths) && !matchesAny(f.path, plan.protectedPathsDeclared))
      .map((f) => failure("config-integrity", `Changed protected file ${f.path} that the plan didn't declare`, { location: f.path })),
    "No undeclared protected files changed",
  ),
});

/** Added lines that switch checks off (verify-runner §2.4 forging controls included). */
export const ESCAPE_HATCHES: { id: string; re: RegExp }[] = [
  { id: "skip-test", re: /\[(Fact|Theory)\s*\([^)]*Skip\s*=|\b(it|test|describe)\.(skip|only)\s*\(|\bx(it|describe)\s*\(|\[Ignore\b|Assert\.Skip/ },
  { id: "suppress-warning", re: /#pragma\s+warning\s+disable|SuppressMessage\(|eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error/ },
  { id: "exit-process", re: /\bprocess\.exit\s*\(|\bEnvironment\.Exit\s*\(|\bos\._exit\s*\(/ },
  { id: "test-report", re: /\.trx\b|TestResults[/\\]|junit\.xml|TESTINGPLATFORM_|VSTEST_/ },
  { id: "patch-assert", re: /(Assert|expect)\s*=\s*|Object\.defineProperty\(\s*(global|globalThis)\s*,\s*['"]expect/ },
];

export const noEscapeHatches = defineGate<{ diff: DiffSummary }>({
  id: "task.no-escape-hatches", after: "implement", safety: false, waiver: "none",
  predicate: ({ diff }, policy) => {
    const fs: Failure[] = [];
    for (const f of diff.files) {
      if (matchesAny(f.path, policy.escapeHatchAllowlist)) continue;
      for (const line of f.added) {
        for (const h of ESCAPE_HATCHES) {
          if (h.re.test(line)) fs.push(failure("escape-hatch", `${h.id} in ${f.path}: ${line.trim().slice(0, 120)}`, { location: f.path }));
        }
      }
      if (f.status === "D" && /(test|spec)/i.test(f.path)) fs.push(failure("escape-hatch", `Deleted test file ${f.path}`, { location: f.path }));
    }
    return verdict(fs, "No escape hatches");
  },
});

export const diffSize = defineGate<{ diff: DiffSummary }>({
  id: "integrate.diff-size", after: "integrate", safety: false, waiver: "human",
  predicate: ({ diff }, policy) => {
    const lines = diff.files.reduce((n, f) => n + f.added.length + f.removed.length, 0);
    return lines > policy.maxDiffLines
      ? { passed: false, details: `Diff has ${lines} changed lines (limit ${policy.maxDiffLines})`, failures: [failure("size", `Diff too large: ${lines} lines`)] }
      : { passed: true, details: `${lines} changed lines` };
  },
});

export const noSecrets = defineGate<{ scan: SecretScan }>({
  id: "secrets.none", after: "implement", safety: true, waiver: "none",
  predicate: ({ scan }) => verdict(
    scan.hits.map((h) => failure("secret", `Possible secret (${h.rule}) in ${h.file}:${h.line}`, { location: `${h.file}:${h.line}` })),
    "No secrets found",
  ),
});

// ---------- test runs ----------

/** Evidence is valid and every expectation holds; locked tests must pass first time. */
export const testExpectations = defineGate<{ run: TestRun; baseline?: TestRun }>({
  id: "tests.expectations", after: "implement", safety: true, waiver: "none",
  predicate: ({ run, baseline }) => {
    if (!run.valid) return { passed: false, details: `Test evidence invalid: ${run.invalidReason}`, failures: [failure("evidence", `Test evidence invalid: ${run.invalidReason}`)] };
    const byId = new Map(run.results.map((r) => [r.id, r]));
    const fs: Failure[] = [];
    for (const id of run.expectPass) {
      const r = byId.get(id);
      if (!r || r.outcome === "notRun" || r.outcome === "skipped") fs.push(failure("locked-not-executed", `Expected test didn't run: ${id}`, { testId: id }));
      else if (r.outcome !== "passed") fs.push(failure("locked-failed", `${id} failed: ${r.message ?? r.failureKind ?? ""}`.trim(), { testId: id, frames: r.frames ?? [] }));
      else if (r.flaky) fs.push(failure("locked-flaky", `${id} passed only on re-run; locked tests must pass first time`, { testId: id }));
    }
    for (const e of run.expectFail) {
      const r = byId.get(e.id);
      if (!r || r.outcome === "notRun" || r.outcome === "skipped") fs.push(failure("expected-fail-missing", `Expected failing test didn't run: ${e.id}`, { testId: e.id }));
      else if (r.outcome === "passed") fs.push(failure("expected-fail-passed", `${e.id} passed, but it should fail before the change`, { testId: e.id }));
      else if (!r.failureKind || !e.kinds.includes(r.failureKind)) fs.push(failure("wrong-failure-kind", `${e.id} failed with ${r.failureKind ?? "unknown"}, expected ${e.kinds.join(" or ")}`, { testId: e.id }));
    }
    if (run.compareToBaseline.length) {
      const baseFailed = new Set(baseline?.results.filter((r) => r.outcome === "failed").map((r) => r.id) ?? []);
      for (const id of run.compareToBaseline) {
        const r = byId.get(id);
        if (r?.outcome === "failed" && !r.flaky && !baseFailed.has(id)) fs.push(failure("new-failure", `New failure vs baseline: ${id}`, { testId: id, frames: r.frames ?? [] }));
      }
    }
    return verdict(fs, `${run.results.length} tests, expectations met`);
  },
});

/** author-tests: two runs on base + stubs; each AC test fails for the right reason both times. */
export const failsOnBase = defineGate<{ run1: TestRun; run2: TestRun; tests: AcceptanceTests }>({
  id: "author-tests.fails-on-base", after: "author-tests", safety: false, waiver: "none",
  predicate: ({ run1, run2, tests }) => {
    const fs: Failure[] = [];
    const ok = new Set(["assertion", "not-implemented"]);
    for (const run of [run1, run2]) {
      if (!run.valid) { fs.push(failure("evidence", `Test evidence invalid: ${run.invalidReason}`)); continue; }
      const byId = new Map(run.results.map((r) => [r.id, r]));
      for (const t of tests.tests) {
        const r = byId.get(t.testId);
        if (!r || r.outcome === "notRun" || r.outcome === "skipped") fs.push(failure("not-executed", `${t.testId} (${t.acId}) didn't run`, { testId: t.testId }));
        // a must-keep-passing criterion ("stays upper case"): it passes on the old code and must keep passing
        else if (t.failsOnBase === false) { if (r.outcome !== "passed") fs.push(failure("keep-passing", `${t.testId} (${t.acId}) describes behaviour that works today, but fails on the old code`, { testId: t.testId })); }
        else if (r.outcome === "passed") fs.push(failure("passes-on-base", `${t.testId} (${t.acId}) already passes before any change`, { testId: t.testId }));
        else if (!ok.has(r.failureKind ?? "")) fs.push(failure("wrong-failure-kind", `${t.testId} fails with ${r.failureKind ?? "unknown"}, not an assertion or not-implemented`, { testId: t.testId, frames: r.frames ?? [] }));
      }
      for (const c of tests.characterisation) {
        const r = byId.get(c.testId);
        // not a normal retry: a characterisation test describes behaviour that works TODAY, so failing on the
        // old code means the test is wrong or needs something the lab doesn't have
        if (r?.outcome !== "passed") fs.push(failure("characterisation", `Characterisation test ${c.testId} fails on the old code, so it doesn't describe today's behaviour: the test is wrong, or it needs a service or data the test lab doesn't have (an external API, seeded rows). Rewrite it as a small unit test next to the changed class, or drop it.${r?.message ? ` It failed with: ${r.message.slice(0, 200)}` : ""}`, { testId: c.testId }));
      }
    }
    if (!tests.tests.length) fs.push(failure("no-tests", "No acceptance tests were written"));
    // every requirement needs at least one test that fails on the old code: that's what proves the change is needed
    const reqs = new Set(tests.tests.map((t) => t.acId.replace(/^AC-(\d+)\..*$/, "REQ-$1")));
    for (const req of reqs) {
      if (!tests.tests.some((t) => t.failsOnBase !== false && t.acId.replace(/^AC-(\d+)\..*$/, "REQ-$1") === req)) fs.push(failure("no-failing-test", `${req} has no test that fails on the old code, so nothing proves the change is needed`));
    }
    return verdict(fs, `${tests.tests.length} AC tests fail on base for the right reason, twice`);
  },
});

// ---------- spec pipeline ----------

export const anchorsResolve = defineGate<{ cb: CurrentBehaviour; resolved: { claim: string; ok: boolean; reason?: string }[] }>({
  id: "ground.anchors-resolve", after: "ground", safety: false, waiver: "none",
  predicate: ({ resolved }) => verdict(
    resolved.filter((r) => !r.ok).map((r) => failure("anchor", `${r.claim}: ${r.reason ?? "anchor doesn't match the file"}`)),
    "Every anchor resolves",
  ),
});

export const planChecks = defineGate<{ plan: Plan; spec: SpecDraft }>({
  id: "plan.checks", after: "plan", safety: false, waiver: "none",
  predicate: ({ plan, spec }) => {
    const fs: Failure[] = [];
    const covered = new Set(plan.tasks.flatMap((t) => t.reqs));
    for (const r of spec.requirements) if (!covered.has(r.id)) fs.push(failure("plan-coverage", `${r.id} isn't covered by any task`));
    if (plan.options.length < 2) fs.push(failure("plan-options", "The plan needs at least 2 options"));
    if (!plan.options.some((o) => o.id === plan.chosen)) fs.push(failure("plan-options", `Chosen option ${plan.chosen} isn't listed`));
    if (!plan.adr.trim()) fs.push(failure("plan-adr", "The plan needs a short decision record"));
    for (const t of plan.tasks) {
      if (t.conventions.length > 15) fs.push(failure("plan-rules", `${t.id} has ${t.conventions.length} rules (max 15)`));
      if (!t.fileScope.length) fs.push(failure("plan-scope", `${t.id} has no file scope`));
    }
    for (let i = 0; i < plan.tasks.length; i++) {
      for (let j = i + 1; j < plan.tasks.length; j++) {
        const a = plan.tasks[i]!, b = plan.tasks[j]!;
        const overlap = a.fileScope.filter((p) => b.fileScope.includes(p) || matchesAny(p, b.fileScope) || b.fileScope.some((q) => matchesAny(q, a.fileScope)));
        if (overlap.length) fs.push(failure("plan-scope-overlap", `${a.id} and ${b.id} share files: ${overlap.join(", ")}`));
      }
    }
    const ids = new Set(plan.tasks.map((t) => t.id));
    for (const t of plan.tasks) for (const d of t.dependsOn) if (!ids.has(d)) fs.push(failure("plan-deps", `${t.id} depends on unknown ${d}`));
    return verdict(fs, `${plan.tasks.length} tasks cover all ${spec.requirements.length} requirements`);
  },
});

// ---------- review ----------

const BLOCKING_CATEGORIES = new Set(["correctness", "spec-mismatch", "error-handling", "security"]);

/** Blocking is derived by code from category, severity and confidence, never by the model. */
export function isBlocking(f: ReviewFinding, policy: Policy): boolean {
  if (f.confidence < policy.reviewConfidence) return false;
  if (f.category === "security") return f.severity !== "low";
  return BLOCKING_CATEGORIES.has(f.category) && (f.severity === "critical" || f.severity === "high");
}

export const reviewBlocking = defineGate<{ review: { findings: ReviewFinding[] }; families: { implementer: string; reviewer: string } }>({
  id: "review.no-blocking", after: "review", safety: false, waiver: "human",
  predicate: ({ review, families }, policy) => {
    const fs = review.findings.filter((f) => isBlocking(f, policy))
      .map((f) => failure("review", `${f.id} [${f.category}/${f.severity}] ${f.file}:${f.line} ${f.text}`, { location: `${f.file}:${f.line}` }));
    const note = families.implementer === families.reviewer ? " (single model family: reviewer = implementer family)" : "";
    const v = verdict(fs, `${review.findings.length} findings, none blocking${note}`);
    return { ...v, details: v.details + (v.passed ? "" : note) };
  },
});

// ---------- deliver ----------

export const shaBinding = defineGate<{ pushed: { headParent: string; manifestOnly: boolean; changed: string[] }; gatedSha: string }>({
  id: "deliver.sha-binding", after: "deliver", safety: true, waiver: "none",
  predicate: ({ pushed, gatedSha }) => {
    const fs: Failure[] = [];
    if (pushed.headParent !== gatedSha) fs.push(failure("sha-binding", `Pushed head's parent ${pushed.headParent.slice(0, 10)} isn't the gated commit ${gatedSha.slice(0, 10)}`));
    if (!pushed.manifestOnly) fs.push(failure("sha-binding", `The manifest commit changes other files: ${pushed.changed.join(", ")}`));
    return verdict(fs, "Pushed = gated commit + manifest-only commit");
  },
});
