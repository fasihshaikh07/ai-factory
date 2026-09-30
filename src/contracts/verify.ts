// Producer outputs (verify-runner.md §2.10).
import { z } from "zod";
import { GitSha, Sha } from "./common.js";
import { FailureKind } from "./artifacts.js";

export const VerifyStage = z.enum(["baseline", "author-tests-on-base", "task", "integrate", "accept", "deliver"]);
export type VerifyStage = z.infer<typeof VerifyStage>;

export const TestOutcome = z.enum(["passed", "failed", "skipped", "notRun"]);

export const TestResult = z.object({
  id: z.string(),
  outcome: TestOutcome,
  failureKind: FailureKind.optional(),
  durationMs: z.number().nonnegative(),
  message: z.string().optional(),
  frames: z.array(z.string()).max(5).optional(),
  flaky: z.boolean().optional(),
});
export type TestResult = z.infer<typeof TestResult>;

export const TestRun = z.object({
  kind: z.literal("test"),
  treeSha: GitSha,
  stage: VerifyStage,
  runner: z.enum(["vstest", "mtp", "jest", "vitest", "playwright"]),
  toolVersions: z.record(z.string(), z.string()),
  expectPass: z.array(z.string()),
  expectFail: z.array(z.object({ id: z.string(), kinds: z.array(FailureKind).min(1) })),
  compareToBaseline: z.array(z.string()),
  discovered: z.array(z.string()),
  results: z.array(TestResult),
  exitCode: z.number().int(),
  reportShas: z.array(Sha),
  valid: z.boolean(),
  invalidReason: z.string().optional(),
  classification: z.enum(["ok", "code", "infra", "upstream"]),
});
export type TestRun = z.infer<typeof TestRun>;

export const BuildRun = z.object({
  kind: z.literal("build"),
  ok: z.boolean(),
  errors: z.array(z.object({ file: z.string(), line: z.number(), code: z.string(), msg: z.string() })),
});
export type BuildRun = z.infer<typeof BuildRun>;

export const LintRun = z.object({
  kind: z.literal("lint"), tool: z.string(), version: z.string(),
  findings: z.array(z.object({
    ruleId: z.string(), file: z.string(), line: z.number(), fingerprint: z.string(), severity: z.string(),
  })),
});
export type LintRun = z.infer<typeof LintRun>;

export const MigrationRun = z.object({
  kind: z.literal("migration"), emptyOk: z.boolean(), seededOk: z.boolean(),
  pendingModelChanges: z.boolean(), squawk: z.array(z.string()),
});

export const AuditRun = z.object({
  kind: z.literal("audit"),
  findings: z.array(z.object({ pkg: z.string(), version: z.string(), advisory: z.string(), severity: z.string() })),
  newDeps: z.array(z.object({
    name: z.string(), registry: z.string(), exists: z.boolean(), ageDays: z.number().optional(),
  })),
});

/** Secret values are never stored, only where they were. */
export const SecretScan = z.object({
  kind: z.literal("secrets"), commit: z.string(),
  hits: z.array(z.object({ file: z.string(), line: z.number(), rule: z.string() })),
});
export type SecretScan = z.infer<typeof SecretScan>;

export const Timing = z.object({
  phase: z.enum(["copy", "restore", "build", "test", "lint", "accept"]),
  ms: z.number(), cacheHit: z.boolean(),
});

export const AcceptEvidence = z.object({
  ac: z.string(),
  /** test: the locked test passed and there is no probe (unit criteria) */
  kind: z.enum(["test", "http", "ui", "db", "job", "manual"]),
  http: z.array(z.object({ method: z.string(), path: z.string(), status: z.number(), bodySha: Sha })).optional(),
  ui: z.object({
    screenshotSha: Sha, traceSha: Sha.optional(),
    axe: z.object({ serious: z.number(), critical: z.number() }).optional(),
  }).optional(),
  db: z.object({ query: z.string(), rowsSha: Sha, rowCount: z.number() }).optional(),
  job: z.object({
    name: z.string(), fakeCalls: z.array(z.object({ target: z.string(), count: z.number() })),
  }).optional(),
  testId: z.string(),
  passed: z.boolean(),
});
export type AcceptEvidence = z.infer<typeof AcceptEvidence>;
