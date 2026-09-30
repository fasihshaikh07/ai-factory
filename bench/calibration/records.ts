// Internal benchmark record (estimates-design.md, "Internal benchmark record"): one row per finished
// step, taken from the ledger through the existing step scorecard. Read-only; no model calls.
import { Ledger } from "../../src/ledger/ledger.js";
import { splitKey } from "../../src/ledger/state.js";
import { scoreRun } from "../../src/report.js";

export interface BenchRecord {
  runId: string;
  step: string;
  /** "implement/TASK-2" → "implement": the class the harness groups by */
  stage: string;
  mode?: string;
  project?: string;
  changeClass?: string;
  outcome: string;
  wallMin: number;
  retries: number;
  tokens: number;
  costUsd: number;
  /** model turns (one `usage` event each), summed over attempts; comparable to a tool round in external data */
  turns: number;
}

/** Records for every step of one run. */
export function recordsFromLedger(ledger: Ledger): BenchRecord[] {
  const created = ledger.events().find((e) => e.type === "run.created")?.data ?? {};
  const str = (k: string) => (typeof created[k] === "string" ? (created[k] as string) : undefined);
  const turns = new Map<string, number>();
  for (const e of ledger.events()) {
    if (e.type !== "usage" || !e.key) continue;
    const step = splitKey(e.key).step;
    turns.set(step, (turns.get(step) ?? 0) + 1);
  }
  const score = scoreRun(ledger);
  return score.steps.map((s) => ({
    runId: score.runId,
    step: s.step,
    stage: s.stage,
    mode: str("mode"),
    project: str("project"),
    changeClass: str("changeClass"),
    outcome: s.outcome,
    wallMin: s.activeSec / 60,
    retries: Math.max(0, s.attempts - 1),
    tokens: s.tokens.input + s.tokens.output + s.tokens.cached,
    costUsd: s.costUsd,
    turns: turns.get(s.step) ?? 0,
  }));
}

/** Records for every run under FACTORY_HOME (copy another machine's ledger there, or point FACTORY_HOME at it). */
export function loadRecords(): { records: BenchRecord[]; runs: number; skipped: string[] } {
  const records: BenchRecord[] = [];
  const skipped: string[] = [];
  let runs = 0;
  for (const id of Ledger.listRuns()) {
    try {
      records.push(...recordsFromLedger(Ledger.open(id)));
      runs++;
    } catch (e) {
      skipped.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { records, runs, skipped };
}
