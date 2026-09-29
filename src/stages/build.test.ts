import { describe, expect, it } from "vitest";
import { failure } from "../gates/engine.js";
import type { LedgerEvent } from "../contracts/index.js";
import { earlierTests, labelRegressions, previousAttempt, retryMode } from "./build.js";

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

describe("retry: keep the previous attempt's code or reset", () => {
  const prev = (checks: string[], over: { rung?: number; interrupted?: boolean } = {}) => ({ checks, rung: over.rung ?? 0, interrupted: over.interrupted ?? false });
  const mode = (checks: string[], rung = 0, over: { rung?: number; interrupted?: boolean } = {}) => retryMode(prev(checks, over), rung).mode;

  it("keeps when only behaviour or the build was wrong, at the same rung", () => {
    expect(mode(["locked-failed"])).toBe("keep");
    expect(mode(["build", "locked-failed", "locked-failed"])).toBe("keep");
    expect(mode(["regression"])).toBe("keep");
    expect(mode(["new-failure", "locked-flaky"], 1, { rung: 1 })).toBe("keep");
    expect(retryMode(prev(["locked-failed"]), 0).reason).toMatch(/failed only on locked-failed/);
  });

  it("resets on any move up the ladder", () => {
    expect(retryMode(prev(["locked-failed"]), 1)).toEqual({ mode: "reset", reason: "moved from rung 0 to rung 1" });
    expect(mode(["regression"], 3, { rung: 2 })).toBe("reset");
  });

  it("resets after safety, scope, escape hatches, agent errors and bad evidence", () => {
    for (const c of ["lock-set", "config-integrity", "secret", "diff-in-scope", "escape-hatch", "agent-timeout", "agent-error", "exception", "evidence", "locked-not-executed", "expected-fail-passed"]) {
      expect(mode(["locked-failed", c]), c).toBe("reset");
    }
    expect(retryMode(prev(["locked-failed", "secret"]), 0).reason).toBe("the previous attempt failed on secret");
  });

  it("resets after an interrupted attempt, and on the first attempt", () => {
    expect(mode(["locked-failed"], 0, { interrupted: true })).toBe("reset");
    expect(retryMode(undefined, 0)).toEqual({ mode: "reset", reason: "no previous attempt" });
    expect(mode([])).toBe("reset");
  });

  it("reads the last attempt since the step last completed from the ledger", () => {
    let seq = 0;
    const ev = (type: string, key: string, data?: Record<string, unknown>) => ({ seq: seq++, ts: "", runId: "r", epoch: 0, type, key, data }) as LedgerEvent;
    const k = "implement/TASK-1";
    const failed = [ev("step.started", `${k}/1`), ev("step.failed", `${k}/1`, { rung: 0, commit: "abc" }), ev("step.started", `${k}/2`)];
    expect(previousAttempt(failed, k, ["locked-failed"])).toEqual({ checks: ["locked-failed"], rung: 0, interrupted: false, commit: "abc" });
    const crashed = [...failed, ev("step.interrupted", `${k}/2`), ev("step.started", `${k}/3`)];
    expect(previousAttempt(crashed, k, ["locked-failed"])!.interrupted).toBe(true);
    const parked = [ev("step.failed", `${k}/1`, { rung: 0, parked: true })];
    expect(previousAttempt(parked, k, [])!.interrupted).toBe(true);
    const done = [...failed, ev("step.completed", `${k}/2`), ev("step.started", `${k}/3`)];
    expect(previousAttempt(done, k, [])).toBeUndefined();
    expect(previousAttempt(failed, "implement/TASK-2", [])).toBeUndefined();
  });
});
