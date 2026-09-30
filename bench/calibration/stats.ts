// Small statistics helpers for the duration/cost harness. No dependencies.

/** Linear-interpolated quantile, q in [0,1]. Throws on an empty list. */
export function quantile(values: number[], q: number): number {
  if (!values.length) throw new Error("quantile of empty list");
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

export interface Band { p10: number; p50: number; p90: number; n: number }

export function band(values: number[]): Band {
  return { p10: quantile(values, 0.1), p50: quantile(values, 0.5), p90: quantile(values, 0.9), n: values.length };
}

/**
 * Confidence label from the number of records behind a band (estimates-design.md, "Task duration").
 * The cut-offs are assumptions; tune them as the ledger grows.
 */
export const CONFIDENCE_CUTOFFS = { partial: 3, calibrated: 10 } as const;
export type Confidence = "cold-start" | "partial" | "calibrated";

export function confidence(n: number): Confidence {
  if (n >= CONFIDENCE_CUTOFFS.calibrated) return "calibrated";
  if (n >= CONFIDENCE_CUTOFFS.partial) return "partial";
  return "cold-start";
}
