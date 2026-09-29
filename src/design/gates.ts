// Design gates, in the style of src/gates/predicates.ts: pure predicates over ledger artifacts.
// The producers (the size classifier over the real diff, the fidelity lint) run in the core and
// store their results; these only read them.
import { defineGate, failure, verdict } from "../gates/engine.js";
import type { CheckResult } from "./fidelity.js";
import { LEVEL_NAMES, rank, type Level, type SizeResult } from "./size.js";

/** Size-cap check: the finished diff may not be a bigger UI change than the one approved. */
export function sizeCapVerdict(actual: Pick<SizeResult, "level" | "reasons">, approved: { level: Level }) {
  if (rank(actual.level) <= rank(approved.level)) {
    return { passed: true, details: `UI change is a ${LEVEL_NAMES[actual.level]}, within the approved ${LEVEL_NAMES[approved.level]}` };
  }
  const over = actual.reasons.filter((r) => r.startsWith(LEVEL_NAMES[actual.level]));
  return {
    passed: false,
    details: `UI change is a ${LEVEL_NAMES[actual.level]}, bigger than the approved ${LEVEL_NAMES[approved.level]}`,
    failures: [failure("design-size-cap", `The change is a ${LEVEL_NAMES[actual.level]}, but a ${LEVEL_NAMES[approved.level]} was approved`),
      ...over.slice(0, 10).map((r) => failure("design-size-cap", r))],
  };
}

export const designSizeCap = defineGate<{ actual: SizeResult; approved: { level: Level } }>({
  id: "design.size-cap", after: "integrate", safety: false, waiver: "human",
  predicate: ({ actual, approved }) => sizeCapVerdict(actual, approved),
});

/** Fidelity lint: FAIL fails; a check that couldn't run fails too (a gate never passes on nothing). */
export const designFidelityLint = defineGate<{ lint: CheckResult[] }>({
  id: "design.fidelity-lint", after: "implement", safety: false, waiver: "human",
  predicate: ({ lint }) => verdict(
    lint.filter((r) => r.status === "FAIL" || r.status === "UNCHECKED")
      .map((r) => failure("design-fidelity", `${r.check}: ${r.status === "UNCHECKED" ? "could not check: " : ""}${r.detail}`)),
    lint.map((r) => `${r.check} ${r.status}`).join("; ") || "nothing to check",
  ),
});
