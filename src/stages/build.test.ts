import { describe, expect, it } from "vitest";
import { failure } from "../gates/engine.js";
import { earlierTests, labelRegressions } from "./build.js";

describe("earlier tasks' locked tests", () => {
  const plan = { tasks: [{ id: "TASK-1" }, { id: "TASK-2" }, { id: "TASK-3" }] };
  const owners = new Map([["AC-1.1", "TASK-1"], ["AC-2.1", "TASK-2"], ["AC-3.1", "TASK-3"]]);
  const tests = [{ acId: "AC-1.1", testId: "t1" }, { acId: "AC-2.1", testId: "t2" }, { acId: "AC-3.1", testId: "t3" }];

  it("takes only tasks before this one in plan order", () => {
    expect([...earlierTests(plan, owners, tests, "TASK-1").keys()]).toEqual([]);
    expect([...earlierTests(plan, owners, tests, "TASK-2").entries()]).toEqual([["t1", { taskId: "TASK-1", acId: "AC-1.1" }]]);
    expect([...earlierTests(plan, owners, tests, "TASK-3").keys()]).toEqual(["t1", "t2"]);
  });

  it("relabels an earlier test's failure as a regression and leaves the rest alone", () => {
    const earlier = earlierTests(plan, owners, tests, "TASK-3");
    const out = labelRegressions([
      failure("locked-failed", "t1 failed: boom", { testId: "t1", frames: ["at A.B()"] }),
      failure("locked-not-executed", "Expected test didn't run: t2", { testId: "t2" }),
      failure("locked-failed", "t3 failed: own", { testId: "t3" }),
      failure("new-failure", "New failure vs baseline: t1", { testId: "t1" }),
    ], earlier);
    expect(out.map((f) => f.check)).toEqual(["regression", "regression", "locked-failed", "new-failure"]);
    expect(out[0]).toEqual({ check: "regression", testId: "t1", frames: ["at A.B()"], message: "Your change broke TASK-1's locked test t1 (AC-1.1): t1 failed: boom" });
    expect(out[1]!.message).toMatch(/^Your change broke TASK-2's locked test t2 \(AC-2\.1\)/);
  });
});
