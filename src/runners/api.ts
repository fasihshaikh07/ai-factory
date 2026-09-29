// ApiRunner: our own read-only loop for thinking steps (core-design §14/§18, adapters.md).
// Tools: read_file, search, repo_map (served by the core over the snapshot) + submit_result.
// No write, shell or network. Output is zod-validated with at most 2 re-asks; ≤ maxTurns turns.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { z } from "zod";
import { toJsonSchema } from "../contracts/index.js";
import type { RepoTools } from "../context/tools.js";
import { TOOL_DEFS } from "../context/tools.js";
import { secret } from "../config/env.js";
import { costUsd } from "./pricing.js";
import { addUsage, configErrorText, emptyUsage, type Effort, type Job, type Result, type Runner } from "./types.js";

export const MAX_REASKS = 2;
const SUBMIT = "submit_result";

// ---------- provider abstraction (so tests can script a model) ----------

export interface ToolSpec { name: string; description: string; schema: Record<string, unknown> }
export interface ToolCall { id: string; name: string; input: unknown }
export interface Turn {
  calls: ToolCall[];
  text: string;
  stop: "tool_use" | "end" | "max_tokens" | "refusal";
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
}
export interface Conversation {
  next(): Promise<Turn>;
  toolResults(results: { id: string; content: string; isError?: boolean }[]): void;
  /** Plain user nudge (when the model answered without calling a tool). */
  say(text: string): void;
}
export interface Provider {
  start(model: string, effort: Effort | undefined, system: string, user: string, tools: ToolSpec[]): Conversation;
}

export class RateLimitedError extends Error {}
/** 400/401/403/404: retrying won't help. */
export class ConfigError extends Error {
  constructor(readonly status: number | undefined, message: string) { super(message); }
}
const CONFIG_STATUSES = new Set([400, 401, 403, 404]);

/** Models that accept output_config.effort (Opus 4.5+, Sonnet 4.6+/5, Fable). Haiku 4.5 does not. */
export function supportsEffort(model: string): boolean {
  return /^claude-(opus-(4-[5-9]|5)|sonnet-(4-6|5)|fable)/.test(model);
}

// ---------- Anthropic ----------

export class AnthropicProvider implements Provider {
  private readonly client: Anthropic;
  constructor(apiKey = secret("ANTHROPIC_API_KEY")) {
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is missing. Add it to ~/.factory/.env");
    this.client = new Anthropic({ apiKey, maxRetries: 2 });
  }

  start(model: string, effort: Effort | undefined, system: string, user: string, tools: ToolSpec[]): Conversation {
    const client = this.client;
    const messages: Anthropic.MessageParam[] = [{ role: "user", content: user }];
    // Stable prefix first: tools → system; cache it (context-builder §2.3).
    const toolParams: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name, description: t.description, input_schema: t.schema as Anthropic.Tool.InputSchema,
    }));
    return {
      async next(): Promise<Turn> {
        let msg: Anthropic.Message;
        try {
          msg = await client.messages.stream({
            model,
            max_tokens: 32000,
            system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
            tools: toolParams,
            tool_choice: { type: "auto" },
            // effort is rejected by Haiku 4.5 and older models
            ...(supportsEffort(model) ? { output_config: { effort: effort ?? "high" } } : {}),
            // cache the conversation as it grows, so each tool turn re-reads it at the cached price
            cache_control: { type: "ephemeral" },
            messages,
          } as Anthropic.MessageStreamParams).finalMessage();
        } catch (e) {
          if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || (e instanceof Anthropic.APIError && e.status === 529)) {
            throw new RateLimitedError((e as Error).message);
          }
          if (e instanceof Anthropic.APIError && CONFIG_STATUSES.has(e.status as number)) throw new ConfigError(e.status as number, (e as Error).message);
          throw e;
        }
        // append the full content (thinking blocks must go back unchanged)
        messages.push({ role: "assistant", content: msg.content as Anthropic.ContentBlockParam[] });
        const calls = msg.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use").map((b) => ({ id: b.id, name: b.name, input: b.input }));
        const text = msg.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n");
        const u = msg.usage;
        return {
          calls, text,
          stop: msg.stop_reason === "refusal" ? "refusal" : msg.stop_reason === "max_tokens" ? "max_tokens" : calls.length ? "tool_use" : "end",
          usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
        };
      },
      toolResults(results) {
        messages.push({
          role: "user",
          content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, content: r.content, is_error: r.isError ?? false })),
        });
      },
      say(text) {
        messages.push({ role: "user", content: text });
      },
    };
  }
}

// ---------- OpenAI (Responses API) and OpenAI-compatible local servers (chat completions) ----------

export class OpenAIProvider implements Provider {
  private readonly client: OpenAI;
  /** local servers (Ollama, vLLM) speak chat completions; OpenAI itself needs the Responses API for tools + reasoning */
  private readonly local: boolean;
  constructor(opts: { apiKey?: string; baseURL?: string; api?: "responses" | "chat" } = {}) {
    const apiKey = opts.apiKey ?? secret("OPENAI_API_KEY");
    if (!apiKey && !opts.baseURL) throw new Error("OPENAI_API_KEY is missing. Add it to ~/.factory/.env");
    this.client = new OpenAI({ apiKey: apiKey ?? "local", baseURL: opts.baseURL, maxRetries: 0 });
    this.local = opts.api ? opts.api === "chat" : !!opts.baseURL;
  }

  start(model: string, effort: Effort | undefined, system: string, user: string, tools: ToolSpec[]): Conversation {
    return this.local ? this.chat(model, effort, system, user, tools) : this.responses(model, effort, system, user, tools);
  }

  private rethrow(e: unknown): never {
    if (e instanceof OpenAI.RateLimitError || e instanceof OpenAI.InternalServerError) throw new RateLimitedError((e as Error).message);
    if (e instanceof OpenAI.APIError && CONFIG_STATUSES.has(e.status as number)) throw new ConfigError(e.status as number, (e as Error).message);
    throw e;
  }

  /** OpenAI: Responses API. Nothing is stored on OpenAI's side (store: false); the conversation is resent each turn. */
  private responses(model: string, effort: Effort | undefined, system: string, user: string, tools: ToolSpec[]): Conversation {
    const client = this.client;
    const input: OpenAI.Responses.ResponseInput = [{ role: "user", content: user }];
    const toolParams: OpenAI.Responses.FunctionTool[] = tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.schema, strict: false }));
    const rethrow = (e: unknown) => this.rethrow(e);
    return {
      async next(): Promise<Turn> {
        let res: OpenAI.Responses.Response;
        try {
          res = await client.responses.create({
            model, instructions: system, input, tools: toolParams, tool_choice: "auto",
            ...(effort ? { reasoning: { effort } } : {}),
            store: false, include: ["reasoning.encrypted_content"],
          });
        } catch (e) {
          rethrow(e);
        }
        // the output items (reasoning, messages, function calls) go back in as input next turn
        input.push(...(res!.output as unknown as OpenAI.Responses.ResponseInputItem[]));
        const calls = res!.output.filter((o): o is OpenAI.Responses.ResponseFunctionToolCall => o.type === "function_call").map((c) => {
          let parsed: unknown;
          try { parsed = JSON.parse(c.arguments || "{}"); } catch { parsed = { __unparsable: true }; }
          return { id: c.call_id, name: c.name, input: parsed };
        });
        const refused = res!.output.some((o) => o.type === "message" && o.content.some((c) => c.type === "refusal"));
        const u = res!.usage;
        const cached = u?.input_tokens_details?.cached_tokens ?? 0;
        return {
          calls, text: res!.output_text ?? "",
          stop: refused ? "refusal" : res!.status === "incomplete" && res!.incomplete_details?.reason === "max_output_tokens" ? "max_tokens" : calls.length ? "tool_use" : "end",
          usage: { inputTokens: (u?.input_tokens ?? 0) - cached, outputTokens: u?.output_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
        };
      },
      toolResults(results) {
        for (const r of results) input.push({ type: "function_call_output", call_id: r.id, output: r.isError ? `ERROR: ${r.content}` : r.content });
      },
      say(text) {
        input.push({ role: "user", content: text });
      },
    };
  }

  /** Local OpenAI-compatible servers: chat completions. */
  private chat(model: string, effort: Effort | undefined, system: string, user: string, tools: ToolSpec[]): Conversation {
    const client = this.client;
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "developer", content: system },
      { role: "user", content: user },
    ];
    const toolParams: OpenAI.Chat.ChatCompletionTool[] = tools.map((t) => ({
      type: "function", function: { name: t.name, description: t.description, parameters: t.schema },
    }));
    const rethrow = (e: unknown) => this.rethrow(e);
    void effort; // local models: no reasoning-effort setting
    return {
      async next(): Promise<Turn> {
        let res: OpenAI.Chat.ChatCompletion;
        try {
          res = await client.chat.completions.create({ model: model.replace(/^ollama\//, ""), messages, tools: toolParams, tool_choice: "auto" });
        } catch (e) {
          rethrow(e);
        }
        const choice = res!.choices[0]!;
        const m = choice.message;
        messages.push(m as OpenAI.Chat.ChatCompletionMessageParam);
        const calls = (m.tool_calls ?? []).filter((c) => c.type === "function").map((c) => {
          const f = (c as OpenAI.Chat.ChatCompletionMessageFunctionToolCall).function;
          let input: unknown;
          try { input = JSON.parse(f.arguments || "{}"); } catch { input = { __unparsable: true }; }
          return { id: c.id, name: f.name, input };
        });
        const u = res!.usage;
        const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
        return {
          calls, text: m.content ?? "",
          stop: m.refusal ? "refusal" : choice.finish_reason === "length" ? "max_tokens" : calls.length ? "tool_use" : "end",
          usage: { inputTokens: (u?.prompt_tokens ?? 0) - cached, outputTokens: u?.completion_tokens ?? 0, cacheRead: cached, cacheWrite: 0 },
        };
      },
      toolResults(results) {
        for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.isError ? `ERROR: ${r.content}` : r.content });
      },
      say(text) {
        messages.push({ role: "user", content: text });
      },
    };
  }
}

// ---------- the loop ----------

export interface ApiRunnerDeps {
  provider: (model: string) => Provider;
  tools?: RepoTools;
  /** For the run trace: one call per model turn, after its tool calls were answered. */
  onTurn?: (t: TurnTrace) => void;
  /** Called after every model call so usage lands in the ledger even if we crash. */
  onUsage?: (u: { model: string; inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number; costUsd: number }) => Promise<void>;
}

export interface TurnTrace {
  model: string; turn: number; ms: number; stop: Turn["stop"];
  usage: Turn["usage"]; costUsd: number;
  text: string;
  calls: { name: string; input: unknown; ms: number; resultChars: number; isError?: boolean; result: string }[];
  schemaError?: string;
}

function zodIssues(err: z.ZodError): string {
  return err.issues.slice(0, 10).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export class ApiRunner implements Runner {
  readonly kind = "api" as const;
  constructor(private readonly deps: ApiRunnerDeps) {}

  async run<T>(job: Job<T>): Promise<Result<T>> {
    const started = Date.now();
    let usage = emptyUsage();
    const deadline = started + job.limits.timeoutSec * 1000;
    const readTools = TOOL_DEFS.filter((t) => job.pack.tools.includes(t.name));
    if (readTools.length && !this.deps.tools) throw new Error("This step needs repo tools but none were provided");
    const tools: ToolSpec[] = [
      ...readTools.map((t) => ({ name: t.name, description: t.description, schema: t.input_schema })),
      {
        name: SUBMIT,
        description: "Submit your final answer. Call this exactly once, when you are done, with the complete result.",
        schema: toJsonSchema(job.schema),
      },
    ];
    const system = `${job.pack.system}\n\nWhen you have the answer, call the ${SUBMIT} tool with it. Don't put the answer in plain text.`;
    const convo = this.deps.provider(job.model).start(job.model, job.effort, system, job.pack.user, tools);
    let reasks = 0;

    const done = (status: Result<T>["status"], extra: Partial<Result<T>> = {}): Result<T> =>
      ({ status, usage: { ...usage, wallMs: Date.now() - started }, ...extra });

    for (let turn = 0; turn < job.limits.maxTurns; turn++) {
      if (Date.now() > deadline) return done("timeout");
      let t: Turn;
      const turnStart = Date.now();
      try {
        t = await convo.next();
      } catch (e) {
        if (e instanceof RateLimitedError) return done("rate-limited", { error: e.message });
        if (e instanceof ConfigError) return done("config-error", { error: configErrorText(e.status, e.message, job.model) });
        return done("error", { error: (e as Error).message });
      }
      const cost = costUsd(job.model, t.usage);
      usage = addUsage(usage, { ...t.usage, turns: 1, estUsd: cost });
      await this.deps.onUsage?.({ model: job.model, ...t.usage, costUsd: cost });
      if (usage.estUsd > job.limits.maxUsd) return done("over-budget");
      if (t.stop === "refusal") return done("refused", { error: "The model declined this request" });

      const traced: TurnTrace["calls"] = [];
      const report = (schemaError?: string) => this.deps.onTurn?.({
        model: job.model, turn: turn + 1, ms: Date.now() - turnStart, stop: t.stop, usage: t.usage, costUsd: cost, text: t.text, calls: traced, schemaError,
      });
      if (!t.calls.length) {
        report();
        if (++reasks > MAX_REASKS) return done("bad-output", { error: "The model never submitted a result" });
        convo.say(`Call the ${SUBMIT} tool with your final answer.`);
        continue;
      }
      const results: { id: string; content: string; isError?: boolean }[] = [];
      let output: T | undefined;
      let schemaError: string | undefined;
      for (const c of t.calls) {
        const callStart = Date.now();
        if (c.name === SUBMIT) {
          const parsed = job.schema.safeParse(c.input);
          if (parsed.success && output === undefined) {
            output = parsed.data;
            results.push({ id: c.id, content: "Accepted." });
          } else if (!parsed.success) {
            reasks++;
            schemaError = zodIssues(parsed.error);
            results.push({ id: c.id, content: `The result doesn't match the schema: ${schemaError}. Fix it and call ${SUBMIT} again.`, isError: true });
          } else {
            results.push({ id: c.id, content: "Already accepted." });
          }
        } else if (readTools.some((r) => r.name === c.name)) {
          results.push({ id: c.id, content: this.deps.tools!.call(c.name, (c.input ?? {}) as Record<string, unknown>) });
        } else {
          results.push({ id: c.id, content: `Tool ${c.name} isn't available.`, isError: true });
        }
        const r = results[results.length - 1]!;
        traced.push({ name: c.name, input: c.input, ms: Date.now() - callStart, resultChars: r.content.length, isError: r.isError, result: r.content });
      }
      report(schemaError);
      if (output !== undefined) return done("ok", { output });
      if (reasks > MAX_REASKS) return done("bad-output", { error: "Output failed the schema after 2 re-asks" });
      convo.toolResults(results);
    }
    return done("bad-output", { error: `No result after ${job.limits.maxTurns} turns` });
  }
}

/** Pick the provider for a model id. Local models go through an OpenAI-compatible base URL for now. */
export function defaultProvider(model: string): Provider {
  if (/^claude-/.test(model)) return new AnthropicProvider();
  if (model.startsWith("ollama/")) return new OpenAIProvider({ baseURL: secret("OLLAMA_BASE_URL") ?? "http://localhost:11434/v1" });
  return new OpenAIProvider();
}
