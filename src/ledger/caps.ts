// Caps (run-manager §2.11). When one is hit the run parks and a human decides.
import type { ChangeClass, Complexity } from "../contracts/index.js";
import type { RunState } from "./state.js";

export const MAX_ATTEMPTS_PER_TASK = 6;
export const MAX_WAIVERS = 3;
export const MAX_INTERRUPTIONS = 3;
export const MAX_REJECTIONS = 2;

/** Class caps in USD (bugfix $5, S $5, M $10, L $20). */
export function costCapUsd(changeClass: ChangeClass | undefined, complexity: Complexity | undefined): number {
  if (!complexity) return changeClass === "bugfix" ? 5 : 10;
  return { S: 5, M: 10, L: 20 }[complexity];
}

/** For now no cap goes below the medium one: the spec work alone can approach $5. */
export const MIN_CAP_USD = 10;

/**
 * The cost limit in force: before plan, the class cap (at least $10); after plan, what was spent up to
 * the plan plus the size's cap (at least $10); a human waiver replaces it.
 */
export function currentCostCap(state: RunState): number {
  if (state.capOverrides.costUsd !== undefined) return state.capOverrides.costUsd; // a human waiver decides
  const cls = Math.max(costCapUsd(state.info.changeClass, state.info.complexity), MIN_CAP_USD);
  const normal = state.info.complexity ? (state.info.spendAtPlan ?? 0) + cls : cls;
  // --max-cost can only lower the limit
  return state.info.maxCostUsd !== undefined ? Math.min(normal, state.info.maxCostUsd) : normal;
}

/** Expected active time per class [EVAL]; the cap is 2×. */
export function wallClockCapMs(complexity: Complexity | undefined): number {
  const expectedMin = { S: 45, M: 90, L: 180 }[complexity ?? "M"];
  return 2 * expectedMin * 60_000;
}

export interface CapHit {
  kind: "cost" | "wall" | "attempts" | "waivers" | "rejections" | "interruptions";
  reason: string;
  /** cost, time and attempts can be waived by a human on a hash-bound card; the rest park */
  waivable: boolean;
  proposal?: { costUsd?: number; wallMinutes?: number; extraAttempts?: number };
}

export function checkCaps(state: RunState, maxAttempts = MAX_ATTEMPTS_PER_TASK): CapHit | undefined {
  const o = state.capOverrides;
  const cap = currentCostCap(state);
  if (state.costUsd >= cap) {
    const step = Math.max(costCapUsd(state.info.changeClass, state.info.complexity), MIN_CAP_USD);
    return { kind: "cost", waivable: true, reason: `Cost limit reached: $${state.costUsd.toFixed(2)} of $${cap.toFixed(2)}`, proposal: { costUsd: Math.ceil(cap + step) } };
  }
  const wall = o.wallMinutes !== undefined ? o.wallMinutes * 60_000 : wallClockCapMs(state.info.complexity);
  if (state.activeMs >= wall) {
    return { kind: "wall", waivable: true, reason: `Active-time limit reached: ${Math.round(state.activeMs / 60_000)} of ${Math.round(wall / 60_000)} min`, proposal: { wallMinutes: Math.round((2 * wall) / 60_000) } };
  }
  if (state.waivers > MAX_WAIVERS) return { kind: "waivers", waivable: false, reason: `More than ${MAX_WAIVERS} waivers in this run` };
  if (state.rejections >= MAX_REJECTIONS) return { kind: "rejections", waivable: false, reason: `Rejected ${state.rejections} times; let's talk before trying again` };
  for (const r of state.steps.values()) {
    if (r.attempts >= maxAttempts + o.extraAttempts && r.status !== "completed") {
      return { kind: "attempts", waivable: true, reason: `${r.step} used ${r.attempts} attempts`, proposal: { extraAttempts: 3 } };
    }
    if (r.interruptions >= MAX_INTERRUPTIONS && r.status !== "completed") {
      return { kind: "interruptions", waivable: false, reason: `${r.step} was interrupted ${r.interruptions} times; something in the environment is wrong` };
    }
  }
  return undefined;
}
