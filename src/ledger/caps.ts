// Caps (run-manager §2.11). When one is hit the run parks and a human decides.
import type { ChangeClass, Complexity } from "../contracts/index.js";
import type { RunState } from "./state.js";

export const MAX_ATTEMPTS_PER_TASK = 6;
export const MAX_WAIVERS = 3;
export const MAX_INTERRUPTIONS = 3;
export const MAX_REJECTIONS = 2;

/** Cost caps in USD. Before plan, size isn't known: bugfix uses its own cap, others use M. */
export function costCapUsd(changeClass: ChangeClass | undefined, complexity: Complexity | undefined): number {
  if (!complexity) return changeClass === "bugfix" ? 5 : 10;
  return { S: 5, M: 10, L: 20 }[complexity];
}

/** Expected active time per class [EVAL]; the cap is 2×. */
export function wallClockCapMs(complexity: Complexity | undefined): number {
  const expectedMin = { S: 45, M: 90, L: 180 }[complexity ?? "M"];
  return 2 * expectedMin * 60_000;
}

export function checkCaps(state: RunState): string | undefined {
  const o = state.capOverrides;
  const cap = o.costUsd ?? costCapUsd(state.info.changeClass, state.info.complexity);
  const raise = ` Raise it with: factory raise-cap ${state.info.runId}`;
  if (state.costUsd >= cap) return `Cost cap reached: $${state.costUsd.toFixed(2)} of $${cap}.${raise} --cost <dollars>`;
  const wall = o.wallMinutes !== undefined ? o.wallMinutes * 60_000 : wallClockCapMs(state.info.complexity);
  if (state.activeMs >= wall) {
    return `Wall-clock cap reached: ${Math.round(state.activeMs / 60_000)} min active.${raise} --minutes <n>`;
  }
  if (state.waivers > MAX_WAIVERS) return `More than ${MAX_WAIVERS} waivers in this run`;
  if (state.rejections >= MAX_REJECTIONS) return `Rejected ${state.rejections} times; let's talk before trying again`;
  for (const r of state.steps.values()) {
    if (r.attempts >= MAX_ATTEMPTS_PER_TASK + o.extraAttempts && r.status !== "completed") {
      return `${r.step} used ${r.attempts} attempts.${raise} --attempts <n>`;
    }
    if (r.interruptions >= MAX_INTERRUPTIONS && r.status !== "completed") {
      return `${r.step} was interrupted ${r.interruptions} times; something in the environment is wrong`;
    }
  }
  return undefined;
}
