import { describe, expect, it } from "vitest";
import { formatAll, formatOutcomes, outcomes, stageStats, type RunScore, type StepScore } from "./report.js";

const step = (step: string, over: Partial<StepScore> = {}): StepScore => ({
  step, stage: step.split("/")[0]!, outcome: "completed", firstTimePass: true, attempts: 1, interruptions: 0, retryReasons: [], highestRung: 0, models: [],
  tokens: { input: 0, output: 0, cached: 0 }, costUsd: 1, activeSec: 60, gates: { passed: 1, failed: 0, failedIds: [] }, human: { cards: 0, decisions: [] }, ...over,
});
const run = (runId: string, over: Partial<RunScore> = {}): RunScore => ({
  runId, status: "delivered", request: "r", costUsd: 1, activeMin: 10, firstTimePassRate: 1, topCost: [], steps: [], ...over,
});
const t0 = "2026-01-01T00:00:00.000Z";
const at = (min: number) => new Date(Date.parse(t0) + min * 60_000).toISOString();
const delivered = (id: string, min: number, over: Partial<RunScore> = {}) =>
  run(id, { createdAt: t0, deliveredAt: at(min), humanCards: ["approval"], ...over });

describe("outcomes", () => {
  it("no runs", () => {
    const o = outcomes([]);
    expect(o).toMatchObject({ runs: 0, delivered: 0, totalCostUsd: 0, costPerDeliveredUsd: undefined, wallMin: {}, firstTimePass: { passed: 0, finished: 0 } });
    expect(formatOutcomes(o)).toContain("Cost per delivered    - (all spend $0.00");
  });

  it("none delivered: counts by status, cost per delivered is -", () => {
    const o = outcomes([run("a", { status: "parked", costUsd: 3 }), run("b", { status: "waiting" }), run("c", { status: "running" })]);
    expect(o).toMatchObject({ runs: 3, delivered: 0, parked: 1, waiting: 1, running: 1, totalCostUsd: 5, humanStopsPerDelivered: undefined });
    const text = formatOutcomes(o);
    expect(text).toContain("0 of 3 runs (1 parked, 1 waiting, 1 running)");
    expect(text).toMatch(/Cost per delivered +- /);
    expect(text).toContain("median -, worst -");
  });

  it("a parked run's spend counts in cost per delivered change", () => {
    const o = outcomes([delivered("a", 30, { costUsd: 2 }), delivered("b", 60, { costUsd: 4 }), run("c", { status: "parked", costUsd: 6 })]);
    expect(o.costPerDeliveredUsd).toBe(6);          // (2 + 4 + 6) / 2
    expect(o.avgDeliveredRunCostUsd).toBe(3);       // (2 + 4) / 2
    expect(formatOutcomes(o)).toContain("$6.00 (all spend $12.00, parked runs included) · a delivered run alone $3.00");
  });

  it("median of an even count averages the middle two; worst is the max", () => {
    const o = outcomes([delivered("a", 10, { activeMin: 1 }), delivered("b", 40, { activeMin: 4 }), delivered("c", 20, { activeMin: 2 }), delivered("d", 90, { activeMin: 8 })]);
    expect(o.wallMin).toEqual({ median: 30, worst: 90 });
    expect(o.activeMinMedian).toBe(3);
  });

  it("human stops per delivered run and the approval-only share", () => {
    const o = outcomes([
      delivered("a", 10), delivered("b", 10, { humanCards: ["question", "approval", "cap"] }),
      delivered("c", 10, { humanCards: ["approval", "approval"] }), run("d", { status: "waiting", humanCards: ["question", "question"] }),
    ]);
    expect(o.humanStopsPerDelivered).toBe(2);       // (1 + 3 + 2) / 3; the waiting run doesn't count
    expect(o.approvalOnlyShare).toBeCloseTo(1 / 3);
    expect(formatOutcomes(o)).toContain("2.0 cards per delivered run · only the plan approval: 33%");
  });

  it("a closed run that was delivered counts as delivered", () => {
    expect(outcomes([delivered("a", 5, { status: "closed: merged" })]).delivered).toBe(1);
  });

  it("first-time pass over finished steps of all runs", () => {
    const o = outcomes([
      run("a", { steps: [step("plan"), step("implement/TASK-1", { firstTimePass: false })] }),
      run("b", { status: "parked", steps: [step("plan"), step("review", { outcome: "failed", firstTimePass: false })] }),
    ]);
    expect(o.firstTimePass).toEqual({ passed: 2, finished: 3, rate: 2 / 3 });
  });
});

describe("stage table", () => {
  const runs = [
    run("a", { costUsd: 7.75, steps: [step("plan", { costUsd: 2.5 }), step("implement/TASK-1", { costUsd: 4, firstTimePass: false, retryReasons: ["build: broke", "build: again"], gates: { passed: 1, failed: 1, failedIds: ["tests.pass"] } }), step("implement/TASK-2", { costUsd: 1.25, activeSec: 33 })] }),
    run("b", { status: "parked", costUsd: 1.4, steps: [step("plan", { costUsd: 1, outcome: "failed", firstTimePass: false }), step("review", { costUsd: 0.4, gates: { passed: 0, failed: 1, failedIds: ["review.no-blocking"] } })] }),
  ];
  it("formatAll prints what it printed before stageStats existed", () => {
    expect(formatAll(runs)).toBe("2 runs · total $9.15\n\nstage            runs  1st-pass   avg cost  avg time  most common problem\nimplement        2     50%           $2.63       47s  build (2×)\nplan             2     100%          $1.75       60s  -\nreview           1     100%          $0.40       60s  review.no-blocking (1×)");
  });
  it("stageStats gives the same numbers as data", () => {
    expect(stageStats(runs)[0]).toEqual({ stage: "implement", count: 2, firstTimePassRate: 0.5, avgCostUsd: 2.625, avgActiveSec: 46.5, topProblem: { reason: "build", count: 2 } });
    expect(stageStats(runs)[1]!.topProblem).toBeUndefined();
  });
});
