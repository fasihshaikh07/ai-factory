import { describe, expect, it } from "vitest";
import {
  IntentBody, LedgerEvent, maxRisk, PlanBody, Sha, SpecDraft, StageName, TestRun, toJsonSchema,
} from "./index.js";

const sha = "a".repeat(64);

describe("contracts", () => {
  it("maxRisk only goes up", () => {
    expect(maxRisk("low", "medium")).toBe("medium");
    expect(maxRisk("high", "low")).toBe("high");
    expect(maxRisk()).toBe("low");
  });

  it("includes the stage names added in stages-aligned §6", () => {
    for (const s of ["stub-commit", "a5-check", "revise-classify", "design-read"]) {
      expect(StageName.options).toContain(s);
    }
  });

  it("rejects a non-sha", () => {
    expect(Sha.safeParse("abc").success).toBe(false);
    expect(Sha.safeParse(sha).success).toBe(true);
  });

  it("validates a ledger event", () => {
    const ev = { seq: 0, ts: new Date().toISOString(), runId: "r", epoch: 1, type: "run.created" };
    expect(LedgerEvent.parse(ev).type).toBe("run.created");
    expect(LedgerEvent.safeParse({ ...ev, type: "nope" }).success).toBe(false);
  });

  it("requires at least one plan task with a file scope", () => {
    const base = { options: [], chosen: "O-1", adr: "x", protectedPathsDeclared: [] };
    expect(PlanBody.safeParse({ ...base, tasks: [] }).success).toBe(false);
    const task = {
      id: "TASK-1", title: "t", reqs: ["REQ-1"], fileScope: [], exemplars: [], conventions: [],
      dependsOn: [], plannedLoc: 10, approach: "x",
    };
    expect(PlanBody.safeParse({ ...base, tasks: [task] }).success).toBe(false);
    expect(PlanBody.safeParse({ ...base, tasks: [{ ...task, fileScope: ["src/a.cs"] }] }).success).toBe(true);
  });

  it("emits JSON Schema for structured output", () => {
    const js = toJsonSchema(IntentBody);
    expect(js.type).toBe("object");
    expect(Object.keys(js.properties as object)).toContain("spans");
    const spec = toJsonSchema(SpecDraft);
    expect(JSON.stringify(spec)).toContain("acceptance");
  });

  it("parses a test run", () => {
    const run = {
      kind: "test", treeSha: "b".repeat(40), stage: "task", runner: "vstest", toolVersions: {},
      expectPass: ["P::A.B"], expectFail: [], compareToBaseline: [], discovered: ["P::A.B"],
      results: [{ id: "P::A.B", outcome: "passed", durationMs: 3 }],
      exitCode: 0, reportShas: [sha], valid: true, classification: "ok",
    };
    expect(TestRun.parse(run).results).toHaveLength(1);
  });
});
