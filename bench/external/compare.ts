// Reads the factory's own ledger records against the pinned external numbers. Only comparisons that mean
// something are made; each one says what it can't show.
//
// Rounds: model turns per implement step (ledger `usage` events) against tool rounds per task in the
// SWE-rebench OpenHands trajectories (resolved tasks). A turn and a round are close but not identical, and
// the external model, scaffold and tasks differ, so read this as "is the agent looping?" and not as a score.
import type { BenchRecord } from "../calibration/records.js";
import { load, type Openhands } from "./priors.js";

export type Position = "below p10" | "within p10-p90" | "above p90";

export interface RoundsRow { runId: string; step: string; outcome: string; turns: number; position: Position }

export interface RoundsComparison {
  reference: { p10: number; p50: number; p90: number; n: number; source: string } | undefined;
  rows: RoundsRow[];
  /** implement-class steps considered (finished or not, with at least one turn) */
  considered: number;
  aboveP90Share: number | null;
}

/** The stage the external data speaks to: an agent turning a task into a change. */
export const IMPLEMENT_STAGE = "implement";

export function compareRounds(records: BenchRecord[], oh: Openhands | null = load<Openhands>("openhands") ?? null): RoundsComparison {
  const resolved = oh?.byOutcome.find((r) => Number(r.resolved) === 1);
  const reference = oh && resolved
    ? { p10: Number(resolved.roundsP10), p50: Number(resolved.roundsP50), p90: Number(resolved.roundsP90), n: Number(resolved.n), source: oh.source.url }
    : undefined;
  const steps = records.filter((r) => r.stage === IMPLEMENT_STAGE && r.turns > 0);
  const rows: RoundsRow[] = reference
    ? steps.map((r) => ({
        runId: r.runId, step: r.step, outcome: r.outcome, turns: r.turns,
        position: r.turns < reference.p10 ? "below p10" : r.turns > reference.p90 ? "above p90" : "within p10-p90",
      }))
    : [];
  return {
    reference, rows, considered: steps.length,
    aboveP90Share: rows.length ? rows.filter((r) => r.position === "above p90").length / rows.length : null,
  };
}

export function formatCompare(c: RoundsComparison, records: BenchRecord[]): string {
  const lines = ["== Compare: factory ledger vs external data =="];
  if (!c.reference) return [...lines, "No OpenHands snapshot found. Run the derive scripts (bench/external/README.md)."].join("\n");
  const r = c.reference;
  lines.push(`Turns per implement step vs tool rounds per resolved task (OpenHands, ${r.n} tasks): p10 ${r.p10} · p50 ${r.p50} · p90 ${r.p90}`);
  if (!c.considered) {
    const stages = new Map<string, number[]>();
    for (const x of records) if (x.turns > 0) stages.set(x.stage, [...(stages.get(x.stage) ?? []), x.turns]);
    lines.push("No implement steps in the ledger yet, so there is nothing to compare. Turns per stage so far (no external reference):");
    for (const [stage, ts] of [...stages].sort()) lines.push(`  ${stage.padEnd(16)} ${ts.length} step(s), ${Math.min(...ts)}-${Math.max(...ts)} turns`);
    return lines.join("\n");
  }
  lines.push("", `${"run".padEnd(24)} ${"step".padEnd(20)} ${"outcome".padEnd(10)} ${"turns".padStart(5)}  position`);
  for (const x of c.rows) lines.push(`${x.runId.slice(0, 24).padEnd(24)} ${x.step.padEnd(20)} ${x.outcome.padEnd(10)} ${String(x.turns).padStart(5)}  ${x.position}`);
  lines.push("", `${Math.round((c.aboveP90Share ?? 0) * 100)}% of implement steps ran above the external p90. Above p90 suggests looping; below p10 suggests trivial tasks or an early stop.`);
  lines.push("Caveat: different model and scaffold, and single-issue Python fixes; a turn is not exactly a tool round.");
  return lines.join("\n");
}
