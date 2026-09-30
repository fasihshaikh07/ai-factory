// Calibration back-test: hold one run out, predict its steps from the other runs, and check whether
// the p10-p90 band covers the actual about 80% of the time. Cost and wall time are checked separately.
import { band, confidence, CONFIDENCE_CUTOFFS, type Confidence } from "./stats.js";
import type { BenchRecord } from "./records.js";

export type Metric = "costUsd" | "wallMin";
export const METRICS: Metric[] = ["costUsd", "wallMin"];

/** Nominal coverage of a p10-p90 band. */
export const TARGET_COVERAGE = 0.8;

export interface StageResult {
  stage: string;
  metric: Metric;
  /** completed steps of this stage, all runs */
  records: number;
  /** held-out predictions made (needs enough records in the other runs) */
  tested: number;
  covered: number;
  coverage: number | null;
  /** median absolute % error of the p50 prediction */
  medianApe: number | null;
  /** mean signed % error of p50 (positive = over-predicted) */
  bias: number | null;
  /** band from all records, for reading; not used for testing */
  band: { p10: number; p50: number; p90: number } | null;
  confidence: Confidence;
}

export interface BacktestOptions {
  /** fewest records from other runs needed to predict a step; defaults to the "partial" cut-off */
  minTrain?: number;
}

const pct = (pred: number, actual: number) => (actual === 0 ? (pred === 0 ? 0 : 1) : (pred - actual) / actual);

export function backtest(all: BenchRecord[], opts: BacktestOptions = {}): StageResult[] {
  const minTrain = opts.minTrain ?? CONFIDENCE_CUTOFFS.partial;
  const done = all.filter((r) => r.outcome === "completed");
  const stages = [...new Set(done.map((r) => r.stage))].sort();
  const out: StageResult[] = [];
  for (const stage of stages) {
    const rows = done.filter((r) => r.stage === stage);
    for (const metric of METRICS) {
      let tested = 0, covered = 0;
      const apes: number[] = [];
      const signed: number[] = [];
      for (const held of rows) {
        const train = rows.filter((r) => r.runId !== held.runId).map((r) => r[metric]);
        if (train.length < minTrain) continue;
        const b = band(train);
        const actual = held[metric];
        tested++;
        if (actual >= b.p10 && actual <= b.p90) covered++;
        const e = pct(b.p50, actual);
        apes.push(Math.abs(e));
        signed.push(e);
      }
      const values = rows.map((r) => r[metric]);
      const b = band(values);
      out.push({
        stage, metric, records: rows.length, tested, covered,
        coverage: tested ? covered / tested : null,
        medianApe: apes.length ? band(apes).p50 : null,
        bias: signed.length ? signed.reduce((a, c) => a + c, 0) / signed.length : null,
        band: { p10: b.p10, p50: b.p50, p90: b.p90 },
        confidence: confidence(rows.length),
      });
    }
  }
  return out;
}

const f = (n: number | null, d = 2) => (n === null ? "-" : n.toFixed(d));
const p = (n: number | null) => (n === null ? "-" : `${Math.round(n * 100)}%`);

export function formatBacktest(results: StageResult[], meta: { runs: number; records: number }): string {
  const lines = [
    `${meta.runs} runs · ${meta.records} step records · target coverage ${p(TARGET_COVERAGE)} for p10-p90`,
    "",
    `${"stage".padEnd(16)} ${"metric".padEnd(8)} ${"n".padStart(4)} ${"tested".padStart(6)} ${"coverage".padStart(8)} ${"med.err".padStart(8)} ${"bias".padStart(6)}  ${"p10 / p50 / p90".padEnd(24)} confidence`,
  ];
  for (const r of results) {
    const bandTxt = r.band ? `${f(r.band.p10)} / ${f(r.band.p50)} / ${f(r.band.p90)}` : "-";
    lines.push(`${r.stage.padEnd(16)} ${r.metric.padEnd(8)} ${String(r.records).padStart(4)} ${String(r.tested).padStart(6)} ${p(r.coverage).padStart(8)} ${p(r.medianApe).padStart(8)} ${p(r.bias).padStart(6)}  ${bandTxt.padEnd(24)} ${r.confidence}`);
  }
  if (!results.some((r) => r.tested > 0)) {
    lines.push("", "Nothing could be back-tested yet: each stage needs at least " + CONFIDENCE_CUTOFFS.partial + " records from other runs. Copy more ledgers in (FACTORY_HOME) and re-run.");
  }
  return lines.join("\n");
}
