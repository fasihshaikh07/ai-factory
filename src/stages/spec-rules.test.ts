import { describe, expect, it } from "vitest";
import { resolveAnswer, scoreQuestions, selectQuestions, verifyDifferences, type ClarifierQuestion, type Sketch } from "./clarify.js";
import { checkMerge, criticBlocks, roundTripCheck } from "./specpipe.js";
import { lintSpec } from "./speclint.js";

const sketch = (texts: string[]): Sketch => ({ spans: [{ id: "I-1", behaviours: texts.map((t) => ({ text: t, kind: "happy" as const })) }] });
const q = (over: Partial<ClarifierQuestion>): ClarifierQuestion => ({
  id: "q", category: "scope", text: "t", options: ["a", "b"], recommended: "a", reason: "r", spans: ["I-1"], impact: 2, impactReason: "", ...over,
});
const cb = { claims: [{ id: "C-1", text: "", spans: ["I-1"], anchors: [{ path: "a", lineStart: 1, lineEnd: 1, quote: "x" }] }], notFound: [{ span: "I-2", searched: ["x"] }] };

describe("clarify rules", () => {
  it("keeps only differences that cite real behaviours in two sketches", () => {
    const sk = [sketch(["x"]), sketch(["y"]), sketch(["x"])];
    const good = { id: "D-1", span: "I-1", topic: "", readings: [{ sketch: 1, behaviour: 0, summary: "" }, { sketch: 2, behaviour: 0, summary: "" }] };
    const sameSketch = { ...good, id: "D-2", readings: [{ sketch: 1, behaviour: 0, summary: "" }, { sketch: 1, behaviour: 0, summary: "" }] };
    const invented = { ...good, id: "D-3", readings: [{ sketch: 1, behaviour: 0, summary: "" }, { sketch: 2, behaviour: 7, summary: "" }] };
    expect(verifyDifferences([good, sameSketch, invented], sk).map((d) => d.id)).toEqual(["D-1"]);
  });

  it("scores uncertainty from outside the model and asks only impact × uncertainty ≥ 4", () => {
    const diffs = [{ id: "D-1", span: "I-1", topic: "", readings: [] }];
    const scored = scoreQuestions([
      q({ id: "a", impact: 2, difference: "D-1" }),          // 2×3 = 6 → ask
      q({ id: "b", impact: 3, spans: ["I-2"] }),             // 3×2 = 6 → ask (grounding found nothing)
      q({ id: "c", impact: 3, spans: ["I-9"], category: "terminology" }), // no anchor → 2 → 6
      q({ id: "d", impact: 1, difference: "D-1" }),          // 1×3 = 3 → assumption
    ], diffs, cb);
    expect(scored.map((s) => s.score)).toEqual([6, 6, 6, 3]);
    const { asked, assumptions } = selectQuestions(scored, 2);
    expect(asked.map((a) => a.id)).toEqual(["Q-1", "Q-2"]);
    expect(asked[0]!.category).toBe("scope");            // goal/scope first at equal score
    expect(assumptions.map((a) => [a.fromQuestion, a.risk])).toEqual([["c", "high"], ["d", "low"]]);
  });

  it("reads letter answers", () => {
    const s = scoreQuestions([q({ options: ["keep", "drop"] })], [], cb)[0]!;
    expect(resolveAnswer(s, "b")).toBe("drop");
    expect(resolveAnswer(s, "only guests")).toBe("only guests");
  });
});

describe("spec rules", () => {
  const req = (id: string, extra = {}) => ({ id, ears: "When a name is given, the Greeter shall return Hello and the name.", op: "ADDED" as const, sources: ["I-1"], acceptance: [{ id: `AC-${id.slice(4)}.1`, given: "a name", when: "greet", then: "the response is Hello Ann", level: "api" as const }], ...extra });
  const spec = (reqs: ReturnType<typeof req>[]) => ({ requirements: reqs, nfrs: [], outOfScope: ["x"], assumptions: [] });

  it("merge: every source must exist; stability = drafts / 3", () => {
    const drafts = [spec([req("REQ-1")]), spec([req("REQ-1")]), spec([req("REQ-1"), req("REQ-2")])];
    const m = { spec: spec([req("REQ-1"), req("REQ-2")]), alignment: [{ mergedReq: "REQ-1", from: ["d1:REQ-1", "d2:REQ-1", "d3:REQ-1"] }, { mergedReq: "REQ-2", from: ["d3:REQ-2"] }], conflicts: [] };
    expect(checkMerge(m, drafts)).toEqual({ errors: [], stability: { "REQ-1": 1, "REQ-2": 1 / 3 } });
    const bad = { ...m, alignment: [{ mergedReq: "REQ-1", from: ["d1:REQ-9"] }] };
    expect(checkMerge(bad, drafts).errors).toEqual(["REQ-1 cites a draft requirement that doesn't exist: d1:REQ-9", "REQ-2 has no source draft"]);
  });

  it("round trip: finds dropped spans and inventions", () => {
    const r = roundTripCheck(["I-1", "I-2"], ["Q-1"], spec([req("REQ-1")]),
      [{ n: 1, text: "greets with Hello" }, { n: 2, text: "adds an admin page" }],
      [{ n: 1, spans: ["I-1"], answers: [] }, { n: 2, spans: [], answers: [] }]);
    expect(r).toEqual({ droppedSpans: ["I-2"], inventedCapabilities: ["adds an admin page"] });
  });

  it("critic blocking is derived from severity", () => {
    expect(criticBlocks({ severity: "high" })).toBe(true);
    expect(criticBlocks({ severity: "medium" })).toBe(false);
  });

  it("lint catches format problems", () => {
    const bad = spec([req("REQ-1", { ears: "The system should be fast.", sources: [], acceptance: [] })]);
    const failed = lintSpec(bad, { spans: ["I-1"], changeClass: "feature", anchorOk: () => true }).filter((l) => !l.passed).map((l) => l.check);
    expect(failed).toEqual(["L2 req-ac", "L3 ears", "L4 vague", "L10 trace"]);
    const good = lintSpec(spec([req("REQ-1")]), { spans: ["I-1"], changeClass: "feature", anchorOk: () => true }).filter((l) => !l.passed);
    expect(good).toEqual([]);
  });
});

describe("audit fixes: model-less steps", () => {
  it("deterministic steps get a retry-only ladder instead of crashing", async () => {
    const { availableRungs } = await import("./routing.js");
    const { ProjectConfig } = await import("../config/project.js");
    const p = ProjectConfig.parse({ project: "x", repo: "/r", stack: "dotnet" });
    for (const st of ["discover", "stub-commit", "integrate", "accept", "deliver", "clarify", "approve"]) {
      expect([...availableRungs(p, st, false)]).toEqual(["retry"]);
    }
    expect([...availableRungs(p, "implement", false)]).toEqual(["retry", "raise-effort", "stronger-model"]);
  });
});
