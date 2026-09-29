// Stage framework: a mode is an ordered list of steps; `next(state)` is a pure function of
// the replayed ledger (run-manager §2.3). Each step reports one outcome; the executor writes
// the events and applies the failure ladder.
import type { Failure, Usage } from "../contracts/index.js";
import type { ProjectConfig } from "../config/project.js";
import type { Policy } from "../gates/policy.js";
import type { Ledger, Writer } from "../ledger/ledger.js";
import type { RunState, StepKey } from "../ledger/state.js";
import type { FailureCategory } from "../gates/ladder.js";

export type StepOutcome =
  /** outputs: named artifact shas (first is the main one). */
  | { kind: "done"; outputs: Record<string, string>; treeSha?: string; data?: Record<string, unknown> }
  /** A human card was written; the executor exits. */
  /** extra: small metadata stored on human.requested (e.g. where the pending work is cached). */
  | { kind: "wait"; card: { cardId: string; kind: string; artifactSha: string; markdown: string; deadline?: string; defaultDecision?: Record<string, unknown>; extra?: Record<string, unknown> } }
  | { kind: "fail"; category: FailureCategory; failures: Failure[]; signature?: string; diffSha?: string; lockedFailedIds?: string[] }
  | { kind: "park"; reason: string }
  /** Run ends without delivery (e.g. not-reproduced). */
  | { kind: "close"; reason: "not-reproduced" | "stopped" };

export interface StepContext {
  runId: string;
  ledger: Ledger;
  writer: Writer;
  state: RunState;
  project: ProjectConfig;
  policy: Policy;
  attempt: number;
  /** ladder rung for this attempt: 0 retry, 1 raise effort, 2 stronger model, 3 other vendor */
  rung: number;
  /** failures from the previous attempt of this step (failures.json) */
  priorFailures: Failure[];
  log: (msg: string) => void;
  /** record model usage as it happens */
  usage: (u: Usage & { model: string }) => Promise<void>;
}

export interface StepDef {
  key: StepKey;
  /** Stage name for templates/routing, e.g. "implement". */
  stage: string;
  /** Artifact shas + anything else this step depends on → inputsHash. Undefined = not ready. */
  inputs(state: RunState, ledger: Ledger): Record<string, unknown> | undefined;
  /** Model used this attempt (part of inputsHash). */
  model?(ctx: Pick<StepContext, "project" | "rung">): string | undefined;
  templateVersion: string;
  coding?: boolean;
  run(ctx: StepContext): Promise<StepOutcome>;
}

/** Latest completed output of a step (main artifact sha) or a named output. */
export function outputOf(state: RunState, step: StepKey, name?: string): string | undefined {
  const r = state.steps.get(step);
  if (r?.status !== "completed") return undefined;
  if (name) return (r.data?.named as Record<string, string> | undefined)?.[name];
  return r.outputs[0];
}

export function readOutput<T>(state: RunState, ledger: Ledger, step: StepKey, name?: string): T | undefined {
  const sha = outputOf(state, step, name);
  return sha ? ledger.getJson<T>(sha) : undefined;
}

export function requireOutput<T>(state: RunState, ledger: Ledger, step: StepKey, name?: string): T {
  const v = readOutput<T>(state, ledger, step, name);
  if (v === undefined) throw new Error(`Missing output of ${step}${name ? `:${name}` : ""}`);
  return v;
}

export function header(runId: string, kind: string, stage: string, inputsHash: string, model?: string) {
  return { kind, schemaVersion: 1 as const, runId, producedBy: { stage, model }, inputsHash, createdAt: new Date().toISOString() };
}

/** Reasons a human gave when rejecting an approval card, oldest first (typed on a TTY: trusted). */
export function planRejections(state: RunState): string[] {
  return state.decisions
    .filter((d) => d.decision === "reject" && d.cardId.startsWith("approval-"))
    .map((d) => String((d as unknown as { reason?: string }).reason ?? "").trim())
    .filter(Boolean);
}
