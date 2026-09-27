// Shared primitives (contracts.md header, §8 StageName leftovers from stages-aligned §6).
import { z } from "zod";

export const Sha = z.string().regex(/^[0-9a-f]{64}$/, "sha256 hex");
export type Sha = z.infer<typeof Sha>;

/** Git object ids are 40 (sha1) or 64 (sha256) hex chars. */
export const GitSha = z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/, "git object id");

export const Id = z.string().min(1);
export type Id = z.infer<typeof Id>;

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

export const Complexity = z.enum(["S", "M", "L"]);
export type Complexity = z.infer<typeof Complexity>;

export const ChangeClass = z.enum(["bugfix", "feature", "refactor", "migration", "config"]);
export type ChangeClass = z.infer<typeof ChangeClass>;

export const Mode = z.enum(["brownfield", "greenfield", "estimate"]);
export type Mode = z.infer<typeof Mode>;

export const StageName = z.enum([
  // contracts §1
  "discover", "intake", "ground", "clarify", "specify", "design",
  "impact", "plan", "approve", "author-tests", "implement",
  "verify", "review", "deliver", "scaffold", "decide-architecture",
  "breakdown", "estimate", "prototype", "integrate", "accept",
  // stages-aligned §6 additions
  "discover-read", "sketches", "clarifier", "merge", "lint", "critic", "round-trip",
  "spec-gate", "design-read", "design-mock", "stub-commit", "a5-check",
  "conflict-resolve", "revise-classify",
]);
export type StageName = z.infer<typeof StageName>;

export const Evidence = z.object({
  path: z.string(),
  lineStart: z.number().int().positive(),
  lineEnd: z.number().int().positive(),
  quote: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative().default(0),
  cacheWrite: z.number().int().nonnegative().default(0),
  turns: z.number().int().nonnegative().default(0),
  wallMs: z.number().nonnegative().default(0),
  estUsd: z.number().nonnegative().default(0),
});
export type Usage = z.infer<typeof Usage>;

export const Failure = z.object({
  check: z.string(),
  testId: z.string().optional(),
  message: z.string(),
  frames: z.array(z.string()).max(5).default([]),
  location: z.string().optional(),
});
export type Failure = z.infer<typeof Failure>;

/** Risk only ever goes up: effective = max(rules, model, impact). */
export function maxRisk(...risks: Risk[]): Risk {
  const order: Risk[] = ["low", "medium", "high"];
  return risks.reduce<Risk>((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), "low");
}
