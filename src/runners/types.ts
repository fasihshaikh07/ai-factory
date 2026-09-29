// One runner interface (adapters.md Part 2). The core does the safety work around it.
import type { z } from "zod";
import type { ContextPack, StageName, Usage } from "../contracts/index.js";

export type Effort = "low" | "medium" | "high" | "xhigh";

export interface Job<T = unknown> {
  step: StageName;
  model: string;
  effort?: Effort;
  pack: ContextPack;
  /** zod schema the result must satisfy (the single schema source). */
  schema: z.ZodType<T>;
  limits: { maxTurns: number; maxUsd: number; timeoutSec: number };
  /** agent runners only: the run's worktree */
  workdir?: string;
}

/** config-error: the API said no in a way retrying can't fix (bad key, unknown model, bad request). */
export type ResultStatus = "ok" | "bad-output" | "timeout" | "over-budget" | "rate-limited" | "refused" | "config-error" | "error";

/** Plain words for a non-retryable API status. */
export function configErrorText(status: number | undefined, detail: string, model?: string): string {
  const m = model ? ` (${model})` : "";
  if (status === 401) return `The API key was refused${m}. Check ANTHROPIC_API_KEY / OPENAI_API_KEY in ~/.factory/.env.`;
  if (status === 403) return `The API refused access${m}: ${detail.slice(0, 200)}`;
  if (status === 404) return `Model not found or not available to this key${m}: ${detail.slice(0, 200)}`;
  return `The API rejected the request${m} (HTTP ${status ?? "?"}): ${detail.slice(0, 300)}`;
}

export interface Result<T = unknown> {
  status: ResultStatus;
  output?: T;
  error?: string;
  usage: Usage;
  /** vendor session id, for audit only */
  sessionId?: string;
}

export interface Runner {
  readonly kind: "api" | "claude-agent" | "codex" | "jcode";
  run<T>(job: Job<T>): Promise<Result<T>>;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, turns: 0, wallMs: 0, estUsd: 0 };
}

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheRead: a.cacheRead + (b.cacheRead ?? 0),
    cacheWrite: a.cacheWrite + (b.cacheWrite ?? 0),
    turns: a.turns + (b.turns ?? 0),
    wallMs: a.wallMs + (b.wallMs ?? 0),
    estUsd: a.estUsd + (b.estUsd ?? 0),
  };
}

/** Model family, for the reviewer ≠ implementer rule. */
export function family(model: string): string {
  if (/claude|opus|sonnet|haiku|fable/i.test(model)) return "anthropic";
  if (/gpt|^o\d|codex/i.test(model)) return "openai";
  if (model.startsWith("ollama/") || model.startsWith("local/")) return "local";
  return model.split(/[/-]/)[0] ?? model;
}
