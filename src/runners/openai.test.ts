// The OpenAI connection against a fake OpenAI server on localhost: no real calls, no cost.
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ContextPack } from "../contracts/index.js";
import { ApiRunner, OpenAIProvider } from "./api.js";

const pack: ContextPack = {
  system: "You are a check.", user: "ping", images: [], pointers: [], tools: ["read_file"],
  manifest: { stage: "critic", model: "gpt-5.5", recipeVersion: "1", sections: [], packTokens: 1, budgetTokens: 10, countMethod: "proxy", redactions: 0, packSha: "0".repeat(64) },
};

let server: http.Server | undefined;
afterEach(() => server?.close());

function fakeOpenAI(reply: (body: Record<string, unknown>, n: number) => { status?: number; json: unknown }) {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c)).on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      seen.push({ path: req.url ?? "", body });
      const r = reply(body, seen.length);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" }).end(JSON.stringify(r.json));
    });
  });
  return new Promise<{ url: string; seen: typeof seen }>((resolve) =>
    server!.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server!.address() as { port: number }).port}/v1`, seen })));
}

const usage = { input_tokens: 120, output_tokens: 20, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 5 }, total_tokens: 140 };
const resp = (output: unknown[]) => ({ id: "resp_1", object: "response", status: "completed", model: "gpt-5.5", output, usage, output_text: "" });

describe("OpenAI via the Responses API", () => {
  it("sends tools with reasoning effort, stores nothing, and returns tool results next turn", async () => {
    const { url, seen } = await fakeOpenAI((_b, n) => n === 1
      ? { json: resp([{ type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" }, { type: "function_call", call_id: "call_1", name: "read_file", arguments: '{"path":"a.cs"}' }]) }
      : { json: resp([{ type: "function_call", call_id: "call_2", name: "submit_result", arguments: '{"ok":true}' }]) });
    const tools = { call: (name: string, input: Record<string, unknown>) => `${name}:${input.path}` };
    const r = await new ApiRunner({ provider: () => new OpenAIProvider({ apiKey: "sk-test", baseURL: url, api: "responses" }), tools: tools as never })
      .run({ step: "critic", model: "gpt-5.5", effort: "high", pack, schema: z.object({ ok: z.literal(true) }), limits: { maxTurns: 4, maxUsd: 1, timeoutSec: 30 } });
    expect(r.status).toBe("ok");
    expect(seen.map((x) => x.path)).toEqual(["/v1/responses", "/v1/responses"]);
    const first = seen[0]!.body;
    expect(first).toMatchObject({ model: "gpt-5.5", instructions: expect.stringContaining("You are a check."), reasoning: { effort: "high" }, store: false, tool_choice: "auto" });
    expect((first.tools as { name: string }[]).map((t) => t.name)).toEqual(["read_file", "submit_result"]);
    const second = seen[1]!.body.input as { type?: string; call_id?: string; output?: string }[];
    expect(second.some((i) => i.type === "reasoning")).toBe(true); // reasoning goes back as input
    expect(second.find((i) => i.type === "function_call_output")).toMatchObject({ call_id: "call_1", output: "read_file:a.cs" });
    expect(r.usage).toMatchObject({ inputTokens: 200, outputTokens: 40, cacheRead: 40 });
  });

  it("a 400 from OpenAI is a config error that stops the run", async () => {
    const { url } = await fakeOpenAI(() => ({ status: 400, json: { error: { message: "Function tools with reasoning_effort are not supported", type: "invalid_request_error" } } }));
    const r = await new ApiRunner({ provider: () => new OpenAIProvider({ apiKey: "sk-test", baseURL: url, api: "responses" }) })
      .run({ step: "critic", model: "gpt-5.5", effort: "high", pack: { ...pack, tools: [] }, schema: z.object({ ok: z.literal(true) }), limits: { maxTurns: 2, maxUsd: 1, timeoutSec: 30 } });
    expect(r.status).toBe("config-error");
    expect(r.error).toMatch(/HTTP 400/);
  });

  it("local servers keep the chat-completions API", async () => {
    const { url, seen } = await fakeOpenAI(() => ({ json: { id: "c", object: "chat.completion", created: 0, model: "qwen", choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "submit_result", arguments: '{"ok":true}' } }] } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } } }));
    const r = await new ApiRunner({ provider: () => new OpenAIProvider({ baseURL: url }) })
      .run({ step: "intake", model: "ollama/qwen3.6", pack: { ...pack, tools: [] }, schema: z.object({ ok: z.literal(true) }), limits: { maxTurns: 2, maxUsd: 1, timeoutSec: 30 } });
    expect(r.status).toBe("ok");
    expect(seen[0]!.path).toBe("/v1/chat/completions");
    expect(seen[0]!.body.model).toBe("qwen3.6");
  });
});
