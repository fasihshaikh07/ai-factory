// The selftest's script must stay consistent with its sample repo (the real run is `factory selftest`).
import { describe, expect, it } from "vitest";
import { agentScript, SAMPLE_REPO, scriptedAnswer } from "./script.js";

describe("selftest script", () => {
  it("grounding and spec anchors quote real lines of the sample repo", () => {
    const ground = scriptedAnswer("You are the grounding step.") as { claims: { anchors: { path: string; lineStart: number; quote: string }[] }[] };
    const spec = scriptedAnswer("Senior engineer writing a behaviour spec") as { requirements: { anchors: { path: string; lineStart: number; quote: string }[] }[] };
    for (const a of [...ground.claims[0]!.anchors, ...spec.requirements[0]!.anchors]) {
      expect(SAMPLE_REPO[a.path]!.split("\n")[a.lineStart - 1]).toBe(a.quote);
    }
  });

  it("the test writer only writes tests and the implementer only its planned file", () => {
    const plan = scriptedAnswer("You plan the implementation of an approved spec") as { tasks: { fileScope: string[] }[] };
    expect(agentScript("author-tests")!.writes.every((w) => w.path.startsWith("Shop.Tests/"))).toBe(true);
    expect(agentScript("implement")!.writes.map((w) => w.path)).toEqual(plan.tasks[0]!.fileScope);
    expect(agentScript("review")).toBeUndefined();
  });

  it("an unknown step fails loudly instead of guessing", () => {
    expect(() => scriptedAnswer("something new")).toThrow(/no scripted answer/);
  });
});
