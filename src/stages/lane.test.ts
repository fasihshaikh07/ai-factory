import { describe, expect, it } from "vitest";
import { stepBudgetUsd } from "../ledger/caps.js";
import type { RunState } from "../ledger/state.js";
import { timeSplit } from "../report.js";
import { LANE, lightBuild, lightSpec } from "./lane.js";
import { downgradeUi } from "./specpipe.js";

describe("light lane", () => {
  it("only small, low-risk work takes it", () => {
    expect(lightSpec({ risk: "low", rigor: "light", changeClass: "feature" })).toBe(true);
    expect(lightSpec({ risk: "low", rigor: "full", changeClass: "bugfix" })).toBe(true);
    expect(lightSpec({ risk: "low", rigor: "full", changeClass: "feature" })).toBe(false);
    expect(lightSpec({ risk: "medium", rigor: "light", changeClass: "bugfix" })).toBe(false);
    expect(lightSpec({ risk: "high", rigor: "light", changeClass: "bugfix" })).toBe(false);
    expect(lightBuild({ risk: "low", rigor: "light", changeClass: "bugfix" }, "S")).toBe(true);
    expect(lightBuild({ risk: "low", rigor: "light", changeClass: "bugfix" }, "M")).toBe(false);
    expect(lightBuild({ risk: "medium", rigor: "light", changeClass: "bugfix" }, "S")).toBe(false);
  });

  it("the full lane keeps what every run had before", () => {
    expect(LANE.full).toMatchObject({ drafts: 3, maxRepairs: 3, groundTurns: 12, testWriterTurns: 60, criticEffort: undefined });
    expect(LANE.light).toMatchObject({ drafts: 1, maxRepairs: 1, groundTurns: 6, testWriterTurns: 25, criticEffort: "medium", maxCharacterisation: 2 });
  });
});

describe("ui criteria become manual checks", () => {
  it("downgrades only ui, and says which", () => {
    const ac = (id: string, level: "unit" | "api" | "job" | "ui" | "manual") => ({ id, given: "g", when: "w", then: "the value is shown", level });
    const spec = { requirements: [{ id: "REQ-1", ears: "e", op: "MODIFIED" as const, sources: ["I-1"], acceptance: [ac("AC-1.1", "unit"), ac("AC-1.2", "ui"), ac("AC-1.3", "api")] }], nfrs: [], outOfScope: [], assumptions: [] };
    const d = downgradeUi(spec);
    expect(d.downgraded).toEqual(["AC-1.2"]);
    expect(d.spec.requirements[0]!.acceptance.map((a) => a.level)).toEqual(["unit", "manual", "api"]);
    expect(downgradeUi(d.spec).downgraded).toEqual([]);
  });
});

describe("a step's budget", () => {
  const state = (costUsd: number, over: Partial<RunState["info"]> = {}) =>
    ({ costUsd, capOverrides: {}, info: { changeClass: "bugfix", complexity: "S", spendAtPlan: 2.5, ...over } }) as unknown as RunState;
  it("is its own limit, but never more than what's left of the run's limit", () => {
    // cap after the plan: $2.50 + $10 minimum = $12.50
    expect(stepBudgetUsd(state(3), 4)).toBe(4);
    expect(stepBudgetUsd(state(10), 4)).toBeCloseTo(2.5);
    // --max-cost 5 with $2.55 spent: the first real run's test writer would have had $2.45, not $4
    expect(stepBudgetUsd(state(2.55, { maxCostUsd: 5 }), 4)).toBeCloseTo(2.45);
    // nothing left: a small floor, so the step runs out and the cap card follows
    expect(stepBudgetUsd(state(5.2, { maxCostUsd: 5 }), 4)).toBe(0.25);
  });
});

describe("time split", () => {
  it("model turns, the agent's container and the lab, per step", () => {
    const ev = (ts: number, step: string, kind: string, msg = "", data?: Record<string, unknown>) => ({ ts: new Date(ts * 1000).toISOString(), elapsedMs: 0, step, kind, msg, data });
    const t = timeSplit([
      ev(0, "plan", "model.turn", "", { ms: 8200 }), ev(9, "plan", "model.turn", "", { ms: 1800 }),
      ev(10, "author-tests", "agent.start"), ev(610, "author-tests", "agent.end"),
      ev(611, "author-tests", "lab.restore", "lab: restore ok (6s)"), ev(680, "author-tests", "lab.build", "lab: build ok (62s)"),
      ev(700, "author-tests", "lab.tests", "lab: tests ran: 15 (3 passed, 12 failed), exit 1 (10s)"), ev(701, "author-tests", "lab.rerun", "lab: re-running 12"),
    ]);
    expect(t.get("plan")).toEqual({ modelSec: 10, agentSec: 0, labSec: 0 });
    expect(t.get("author-tests")).toEqual({ modelSec: 0, agentSec: 600, labSec: 78 });
  });
});
