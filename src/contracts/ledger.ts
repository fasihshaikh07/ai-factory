// Ledger events and gate results (contracts §8, run-manager §2.4, gate-engine §2.1).
import { z } from "zod";
import { Failure, GitSha, Sha } from "./common.js";

export const EventType = z.enum([
  "run.created", "run.resumed", "run.pause-requested", "run.paused", "run.parked",
  "run.stop-requested", "run.stopped", "run.delivered", "run.closed",
  "step.started", "step.completed", "step.failed", "step.interrupted",
  "gate.result", "human.requested", "human.decided", "change.received",
  "sink.intent", "sink.done", "usage",
  "workspace.created", "workspace.removed", "container.started", "container.removed",
  "ledger.repaired", "version.changed",
]);
export type EventType = z.infer<typeof EventType>;

export const LedgerEvent = z.object({
  seq: z.number().int().nonnegative(),
  ts: z.string(),
  runId: z.string(),
  epoch: z.number().int().nonnegative(),
  type: EventType,
  key: z.string().optional(),
  inputsHash: Sha.optional(),
  treeSha: GitSha.optional(),
  outputs: z.array(Sha).optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});
export type LedgerEvent = z.infer<typeof LedgerEvent>;

/** What a writer supplies; seq/ts/runId/epoch are filled in by the ledger. */
export type NewEvent = Omit<LedgerEvent, "seq" | "ts" | "runId" | "epoch">;

export const GateResult = z.object({
  gateId: z.string(),
  passed: z.boolean(),
  details: z.string(),
  failures: z.array(Failure).optional(),
  /** safety failures can't be waived and take rung 1 of the ladder */
  safety: z.boolean().default(false),
  inputsHash: Sha,
  treeSha: GitSha.optional(),
  waiver: z.object({ human: z.string(), reason: z.string(), boundTo: Sha }).optional(),
});
export type GateResult = z.infer<typeof GateResult>;

export const RunStatus = z.union([
  z.enum(["created", "running", "waiting", "paused", "parked", "delivered"]),
  z.object({ closed: z.enum(["merged", "pr-closed", "not-reproduced", "stopped"]) }),
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const HumanDecision = z.enum(["approve", "reject", "answer", "waive", "unlock", "waive-cap"]);
export type HumanDecision = z.infer<typeof HumanDecision>;
