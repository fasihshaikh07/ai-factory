// TestRun validity (verify-runner §2.4) and outcome classification (§2.6). Pure.
import type { FailureKind, TestResult, TestRun, VerifyStage } from "../contracts/index.js";

export interface Expectations {
  expectPass: string[];
  expectFail: { id: string; kinds: FailureKind[] }[];
  compareToBaseline: string[];
}

export interface RawRun {
  reports: { sha: string; writtenAfterStart: boolean; parsed: boolean }[];
  results: TestResult[];
  discovered: string[];
  exitCode: number;
  buildFailed?: boolean;
}

/** A report is valid only if all of §2.4's four conditions hold. */
export function validate(raw: RawRun, exp: Expectations): { valid: boolean; reason?: string } {
  if (raw.buildFailed) return { valid: true }; // a failed build is valid evidence of failure
  if (!raw.reports.length) return { valid: false, reason: "no test report was written" };
  const bad = raw.reports.find((r) => !r.parsed || !r.writtenAfterStart);
  if (bad) return { valid: false, reason: bad.parsed ? "a report is older than the test run" : "a report doesn't parse" };
  const ids = new Set(raw.results.map((r) => r.id));
  const executed = raw.results.filter((r) => r.outcome === "passed" || r.outcome === "failed").length;
  const inScope = raw.discovered.length;
  if (executed < inScope) return { valid: false, reason: `only ${executed} of ${inScope} discovered tests executed` };
  const missing = [...exp.expectPass, ...exp.expectFail.map((e) => e.id)].filter((id) => !ids.has(id));
  if (missing.length) return { valid: false, reason: `expected tests missing from the report: ${missing.slice(0, 5).join(", ")}` };
  const anyFailed = raw.results.some((r) => r.outcome === "failed");
  if (anyFailed && raw.exitCode === 0) return { valid: false, reason: "tests failed but the runner exited 0" };
  if (!anyFailed && raw.exitCode !== 0) return { valid: false, reason: `runner exited ${raw.exitCode} with no failed test` };
  return { valid: true };
}

export const INFRA_CLUSTER = 5; // [EVAL]

/**
 * Infra only if a core probe fails (verify-runner §2.6). The probe runs after the tests
 * when ≥5 tests failed with connection or timeout errors.
 */
export function classify(results: TestResult[], probeOk: () => boolean): TestRun["classification"] {
  const failed = results.filter((r) => r.outcome === "failed");
  if (!failed.length) return "ok";
  const infraLike = failed.filter((r) => r.failureKind === "infra" || r.failureKind === "timeout").length;
  if (infraLike >= INFRA_CLUSTER && !probeOk()) return "infra";
  return "code";
}

export function needsProbe(results: TestResult[]): boolean {
  return results.filter((r) => r.outcome === "failed" && (r.failureKind === "infra" || r.failureKind === "timeout")).length >= INFRA_CLUSTER;
}

/** Non-locked failing tests get one re-run; locked (expectPass) never do. */
/**
 * Failed, unlocked tests worth one more run. Tests that already failed before any change (the repo's
 * known failures) aren't: they'd fill the re-run limit, so a flaky timing test would never get its
 * second chance (a repo with 100 known failures re-ran nothing).
 */
export function rerunCandidates(results: TestResult[], exp: Expectations, knownFailures: ReadonlySet<string> = new Set()): string[] {
  const locked = new Set([...exp.expectPass, ...exp.expectFail.map((e) => e.id)]);
  return results.filter((r) => r.outcome === "failed" && !locked.has(r.id) && !knownFailures.has(r.id)).map((r) => r.id);
}

export function markFlaky(results: TestResult[], rerun: TestResult[]): TestResult[] {
  const passedAgain = new Set(rerun.filter((r) => r.outcome === "passed").map((r) => r.id));
  return results.map((r) => (r.outcome === "failed" && passedAgain.has(r.id) ? { ...r, outcome: "passed", flaky: true } : r));
}

export function buildTestRun(args: {
  treeSha: string; stage: VerifyStage; toolVersions: Record<string, string>; exp: Expectations; raw: RawRun;
  probeOk: () => boolean;
}): TestRun {
  const { valid, reason } = validate(args.raw, args.exp);
  let results = args.raw.results;
  if (args.raw.buildFailed) {
    // a compile failure: every expected test is a compile failure
    const ids = [...args.exp.expectPass, ...args.exp.expectFail.map((e) => e.id)];
    results = ids.map((id) => ({ id, outcome: "failed" as const, failureKind: "compile" as const, durationMs: 0, message: "Build failed" }));
  }
  return {
    kind: "test",
    treeSha: args.treeSha,
    stage: args.stage,
    runner: "vstest",
    toolVersions: args.toolVersions,
    expectPass: args.exp.expectPass,
    expectFail: args.exp.expectFail,
    compareToBaseline: args.exp.compareToBaseline,
    discovered: args.raw.discovered,
    results,
    exitCode: args.raw.exitCode,
    reportShas: args.raw.reports.map((r) => r.sha),
    valid,
    invalidReason: reason,
    classification: valid ? (args.raw.buildFailed ? "code" : classify(results, args.probeOk)) : "code",
  };
}
