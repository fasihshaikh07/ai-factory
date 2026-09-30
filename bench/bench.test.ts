import { describe, expect, it } from "vitest";
import { backtest } from "./calibration/backtest.js";
import type { BenchRecord } from "./calibration/records.js";
import { band, confidence, quantile } from "./calibration/stats.js";
import { compareRounds } from "./external/compare.js";
import { buildEvidence } from "./external/evidence.js";
import type { Openhands } from "./external/priors.js";
import { CASES } from "./gates/cases.js";
import { allGood, runCase, runCases, summarise } from "./gates/run.js";

const rec = (runId: string, stage: string, costUsd: number, wallMin = costUsd): BenchRecord => ({
  runId, step: stage, stage, outcome: "completed", wallMin, retries: 0, tokens: 0, costUsd, turns: 0,
});

describe("stats", () => {
  it("interpolates quantiles", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([0, 10], 0.1)).toBeCloseTo(1);
    expect(band([5])).toEqual({ p10: 5, p50: 5, p90: 5, n: 1 });
  });
  it("labels confidence by record count", () => {
    expect([0, 2, 3, 9, 10].map(confidence)).toEqual(["cold-start", "cold-start", "partial", "partial", "calibrated"]);
  });
});

describe("backtest", () => {
  it("makes no prediction without enough other-run records", () => {
    const r = backtest([rec("a", "spec", 1), rec("b", "spec", 2)]);
    expect(r.every((x) => x.tested === 0 && x.coverage === null)).toBe(true);
  });
  it("covers a held-out value inside the band and misses one far outside it", () => {
    const rows = ["a", "b", "c", "d", "e"].map((id) => rec(id, "spec", 10));
    const inside = backtest(rows).find((x) => x.metric === "costUsd")!;
    expect(inside.tested).toBe(5);
    expect(inside.coverage).toBe(1);
    const withOutlier = backtest([...rows, rec("f", "spec", 500)]).find((x) => x.metric === "costUsd")!;
    expect(withOutlier.covered).toBe(withOutlier.tested - 1);
  });
  it("ignores steps that did not complete", () => {
    const rows = [...["a", "b", "c", "d"].map((id) => rec(id, "spec", 5)), { ...rec("e", "spec", 999), outcome: "failed" }];
    expect(backtest(rows).find((x) => x.metric === "costUsd")!.records).toBe(4);
  });
});

describe("gate efficacy", () => {
  it("catches every seeded defect and passes every clean input on the gates that exist", () => {
    const ran = runCases().filter((r) => r.status !== "pending");
    expect(ran.length).toBeGreaterThan(0);
    expect(allGood(ran)).toBe(true);
  });
  it("reports unregistered gates as pending, not as passes", () => {
    const r = runCase({ id: "x", gateId: "no-such-gate", description: "", expect: "must-fail", input: {} });
    expect(r.status).toBe("pending");
  });
  it("counts a gate that lets a defect through as missed", () => {
    const c = CASES.find((x) => x.id === "diff-in-scope/outside")!;
    const cleanInput = CASES.find((x) => x.id === "diff-in-scope/clean")!.input;
    expect(runCase({ ...c, input: cleanInput }).status).toBe("missed");
  });
  it("counts a thrown gate as an error (fail closed)", () => {
    expect(runCase({ id: "x", gateId: "task.diff-in-scope", description: "", expect: "must-fail", input: null }).status).toBe("error");
  });
  it("summarises per gate", () => {
    const s = summarise(runCases()).find((x) => x.gateId === "task.diff-in-scope")!;
    expect(s.catchRate).toBe(1);
    expect(s.falsePositiveRate).toBe(0);
  });
});

describe("compare rounds against external data", () => {
  const oh = { byOutcome: [{ resolved: 1, n: 100, roundsP10: 40, roundsP50: 55, roundsP90: 80 }], source: { url: "u" } } as unknown as Openhands;
  const step = (id: string, stage: string, turns: number): BenchRecord => ({ ...rec(id, stage, 1), step: `${stage}/T`, turns });
  it("places implement steps against the external band and ignores other stages", () => {
    const c = compareRounds([step("a", "implement", 10), step("b", "implement", 60), step("c", "implement", 200), step("d", "specify", 500)], oh);
    expect(c.rows.map((r) => r.position)).toEqual(["below p10", "within p10-p90", "above p90"]);
    expect(c.aboveP90Share).toBeCloseTo(1 / 3);
  });
  it("has nothing to say without implement steps or without a snapshot", () => {
    expect(compareRounds([step("a", "specify", 30)], oh).considered).toBe(0);
    expect(compareRounds([step("a", "implement", 30)], null).rows).toEqual([]);
  });
});

describe("evidence pack", () => {
  const est = {
    deliveryModel: "hitl" as const, planningCostUsd: { min: 1, max: 3 }, planningMinutes: { min: 5, max: 15 },
    tasks: [{ id: "E1", humanEquivMinutes: 30, executor: "factory" as const, factoryMinutes: 20 }, { id: "E2", humanEquivMinutes: 600, executor: "factory" as const, factoryMinutes: 90 }],
    prs: [{ id: "P1", lines: 50 }], assumptions: { parkedRunRate: 0.4, prToMergeHours: 5 },
  };
  const metr = { source: { url: "m" }, suites: { "1-1": { byHumanDuration: [
    { bucket: "3: 15-60 min", success: 0.8, runs: 10, agent_wall_min_median: 60, agent_wall_min_p90: 200 },
    { bucket: "5: 4-16 h", success: 0.2, runs: 10, agent_wall_min_median: 180, agent_wall_min_p90: 400 },
  ] } } };
  const aidev = { source: { url: "a" }, overallBySize: [{ band: "2: 21-100", prs: 5, mergeHoursMedianReviewed: 6, mergeHoursP90Reviewed: 100, mergeHoursMedianUnreviewed: 0.05, mergeHoursP90Unreviewed: 2 }] };
  const planning = (runId: string, cost: number, wallMin = 10): BenchRecord => ({ ...rec(runId, "specify", cost, wallMin), outcome: "completed" });
  const build = (opts = {}) => buildEvidence(est, [], { metr, aidev, ...opts } as never);

  it("always returns a verdict and a source line for every external row", () => {
    for (const r of build()) {
      expect(r.verdict).toBeTruthy();
      if (r.referenceFrom === "external") expect(r.source).toBeTruthy();
    }
  });
  it("draws no verdict from fewer than 3 runs, and one when there are enough", () => {
    const few = buildEvidence(est, [planning("a", 2)], { metr, aidev } as never).find((r) => r.id === "cost.planning")!;
    expect(few.verdict).toBe("cold-start");
    const many = buildEvidence(est, ["a", "b", "c"].map((id) => planning(id, 2)), { metr, aidev } as never).find((r) => r.id === "cost.planning")!;
    expect(many.verdict).toBe("consistent");
    const far = buildEvidence({ ...est, planningCostUsd: { min: 50, max: 60 } }, ["a", "b", "c"].map((id) => planning(id, 2)), { metr, aidev } as never).find((r) => r.id === "cost.planning")!;
    expect(far.verdict).toBe("outside reference");
  });
  it("flags a parked-run rate far below what the external success rates imply", () => {
    const row = (rate: number) => buildEvidence({ ...est, assumptions: { ...est.assumptions, parkedRunRate: rate } }, [], { metr, aidev } as never).find((r) => r.id === "reliability.parked")!;
    expect(row(0.5).verdict).toBe("consistent");   // implied (0.2 + 0.8) / 2 = 0.5
    expect(row(0.05).verdict).toBe("outside reference");
  });
  it("compares task time against the external upper bound", () => {
    const row = (mins: number) => buildEvidence({ ...est, tasks: [{ ...est.tasks[0]!, factoryMinutes: mins }] }, [], { metr, aidev } as never).find((r) => r.id === "time.task")!;
    expect(row(20).verdict).toBe("consistent");
    expect(row(250).verdict).toBe("outside reference");   // p90 for a 30-minute task is 200
    expect(row(20).caveat).toMatch(/upper bound/i);
  });
  it("compares PR merge time against reviewed PRs for HITL and unreviewed PRs for agentic", () => {
    const at = (model: "hitl" | "agentic", h: number) => buildEvidence({ ...est, deliveryModel: model, assumptions: { ...est.assumptions, prToMergeHours: h } }, [], { metr, aidev } as never).find((r) => r.id === "time.pr")!;
    expect(at("hitl", 8).verdict).toBe("consistent");       // 3 to 100 h
    expect(at("hitl", 1).verdict).toBe("outside reference");
    expect(at("agentic", 1).verdict).toBe("consistent");    // 0.025 to 2 h
    expect(at("agentic", 8).verdict).toBe("outside reference");
    expect(buildEvidence(est, [], { metr: null, aidev: null }).find((r) => r.id === "time.pr")!.verdict).toBe("no reference");
  });
  it("compares planning time with the ledger and makes no per-task build-cost row", () => {
    const rows = buildEvidence(est, ["a", "b", "c"].map((id) => planning(id, 2)), { metr, aidev } as never);
    expect(rows.find((r) => r.id === "time.planning")!.verdict).toBe("consistent");
    expect(rows.some((r) => r.id === "cost.build")).toBe(false);
  });
});
