import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { ContextPack } from "../contracts/index.js";
import { ApiRunner, RateLimitedError, type Conversation, type Provider, type Turn } from "./api.js";
import { costUsd } from "./pricing.js";
import { family } from "./types.js";

const pack = (tools: string[] = []): ContextPack => ({
  system: "sys", user: "usr", images: [], pointers: [], tools,
  manifest: { stage: "intake", model: "m", recipeVersion: "1", sections: [], packTokens: 1, budgetTokens: 10, countMethod: "proxy", redactions: 0, packSha: "0".repeat(64) },
});
const U = { inputTokens: 1000, outputTokens: 100, cacheRead: 0, cacheWrite: 0 };

/** A provider that plays back scripted turns and records what it was sent. */
function scripted(turns: (Turn | Error)[]) {
  const seen: { toolResults: { id: string; content: string; isError?: boolean }[][]; said: string[]; tools: string[] } = { toolResults: [], said: [], tools: [] };
  const provider: Provider = {
    start(_m, _e, _s, _u, tools): Conversation {
      seen.tools = tools.map((t) => t.name);
      let i = 0;
      return {
        async next() {
          const t = turns[i++];
          if (!t) throw new Error("script ran out");
          if (t instanceof Error) throw t;
          return t;
        },
        toolResults(r) { seen.toolResults.push(r); },
        say(x) { seen.said.push(x); },
      };
    },
  };
  return { provider, seen };
}
const call = (name: string, input: unknown, id = "t1"): Turn => ({ calls: [{ id, name, input }], text: "", stop: "tool_use", usage: U });
const Out = z.object({ changeClass: z.enum(["bugfix", "feature"]), spans: z.array(z.string()).min(1) });
const job = (over = {}) => ({ step: "intake" as const, model: "claude-sonnet-5", pack: pack(), schema: Out, limits: { maxTurns: 8, maxUsd: 1, timeoutSec: 60 }, ...over });

describe("ApiRunner", () => {
  it("returns validated output from submit_result", async () => {
    const { provider, seen } = scripted([call("submit_result", { changeClass: "bugfix", spans: ["x"] })]);
    const usage: number[] = [];
    const r = await new ApiRunner({ provider: () => provider, onUsage: async (u) => { usage.push(u.costUsd); } }).run(job());
    expect(r.status).toBe("ok");
    expect(r.output).toEqual({ changeClass: "bugfix", spans: ["x"] });
    expect(seen.tools).toEqual(["submit_result"]);
    expect(usage).toHaveLength(1);
    expect(r.usage.estUsd).toBeCloseTo(costUsd("claude-sonnet-5", U));
  });

  it("re-asks on schema errors, at most twice", async () => {
    const bad = call("submit_result", { changeClass: "nope", spans: [] });
    const { provider, seen } = scripted([bad, call("submit_result", { changeClass: "feature", spans: ["a"] })]);
    const r = await new ApiRunner({ provider: () => provider }).run(job());
    expect(r.status).toBe("ok");
    expect(seen.toolResults[0]![0]!.isError).toBe(true);
    expect(seen.toolResults[0]![0]!.content).toMatch(/changeClass/);
    const { provider: p2 } = scripted([bad, bad, bad, bad]);
    expect((await new ApiRunner({ provider: () => p2 }).run(job())).status).toBe("bad-output");
  });

  it("serves read-only tools and refuses anything else", async () => {
    const tools = { call: (n: string, i: Record<string, unknown>) => `${n}:${JSON.stringify(i)}` };
    const { provider, seen } = scripted([
      { calls: [{ id: "a", name: "read_file", input: { path: "x.cs" } }, { id: "b", name: "bash", input: { cmd: "rm -rf /" } }], text: "", stop: "tool_use", usage: U },
      call("submit_result", { changeClass: "bugfix", spans: ["x"] }),
    ]);
    const r = await new ApiRunner({ provider: () => provider, tools: tools as never }).run(job({ pack: pack(["read_file"]) }));
    expect(r.status).toBe("ok");
    expect(seen.tools).toEqual(["read_file", "submit_result"]);
    expect(seen.toolResults[0]).toEqual([
      { id: "a", content: 'read_file:{"path":"x.cs"}' },
      { id: "b", content: "Tool bash isn't available.", isError: true },
    ]);
  });

  it("stops at the turn cap, the cost cap, on refusal and on rate limits", async () => {
    const loop = Array.from({ length: 5 }, () => ({ calls: [{ id: "x", name: "read_file", input: {} }], text: "", stop: "tool_use" as const, usage: U }));
    const tools = { call: () => "ok" };
    expect((await new ApiRunner({ provider: () => scripted(loop).provider, tools: tools as never }).run(job({ pack: pack(["read_file"]), limits: { maxTurns: 3, maxUsd: 1, timeoutSec: 60 } }))).status).toBe("bad-output");
    expect((await new ApiRunner({ provider: () => scripted(loop).provider, tools: tools as never }).run(job({ pack: pack(["read_file"]), limits: { maxTurns: 8, maxUsd: 0.0001, timeoutSec: 60 } }))).status).toBe("over-budget");
    expect((await new ApiRunner({ provider: () => scripted([{ calls: [], text: "", stop: "refusal", usage: U }]).provider }).run(job())).status).toBe("refused");
    expect((await new ApiRunner({ provider: () => scripted([new RateLimitedError("429")]).provider }).run(job())).status).toBe("rate-limited");
  });

  it("nudges when the model answers in plain text", async () => {
    const { provider, seen } = scripted([{ calls: [], text: "It's a bugfix", stop: "end", usage: U }, call("submit_result", { changeClass: "bugfix", spans: ["x"] })]);
    expect((await new ApiRunner({ provider: () => provider }).run(job())).status).toBe("ok");
    expect(seen.said[0]).toMatch(/submit_result/);
  });
});

describe("helpers", () => {
  it("prices and families", () => {
    expect(costUsd("claude-opus-5-5", { inputTokens: 1_000_000, outputTokens: 0, cacheRead: 0, cacheWrite: 0 })).toBe(4);
    expect(costUsd("ollama/qwen3.6", { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheRead: 0, cacheWrite: 0 })).toBe(0);
    expect(family("claude-sonnet-5")).toBe("anthropic");
    expect(family("gpt-5.5")).toBe("openai");
  });
});

describe("audit fixes", () => {
  it("sends effort only to models that accept it", async () => {
    const { supportsEffort } = await import("./api.js");
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
    expect(supportsEffort("claude-sonnet-5")).toBe(true);
    expect(supportsEffort("claude-opus-5-5")).toBe(true);
    expect(supportsEffort("gpt-5.5")).toBe(false);
  });

  it("tells the model when its next turn is the last one", async () => {
    const read = (id: string) => ({ calls: [{ id, name: "read_file", input: { path: "x.cs" } }], text: "", stop: "tool_use" as const, usage: U });
    const { provider, seen } = scripted([read("a"), read("b"), call("submit_result", { changeClass: "bugfix", spans: ["x"] })]);
    const tools = { specs: [{ name: "read_file", description: "d", input_schema: {} }], call: () => "file text" };
    const r = await new ApiRunner({ provider: () => provider, tools: tools as never }).run(job({ pack: pack(["read_file"]), limits: { maxTurns: 3, maxUsd: 1, timeoutSec: 60 } }));
    expect(r.status).toBe("ok");
    expect(seen.toolResults[0]![0]!.content).toBe("file text");
    expect(seen.toolResults[1]![0]!.content).toContain("Your next turn is your last one: call submit_result now");
  });
});

