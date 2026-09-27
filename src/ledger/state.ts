// RunState is derived only by replaying the ledger (run-manager §2.2, §2.4). Never stored.
import type { ChangeClass, Complexity, LedgerEvent, Mode, RunStatus } from "../contracts/index.js";
import { hashJson } from "../util/hash.js";

/** Step key without the attempt: "plan", "implement/TASK-2". */
export type StepKey = string;

export function eventKey(step: StepKey, attempt: number): string {
  return `${step}/${attempt}`;
}

export function splitKey(key: string): { step: StepKey; attempt: number } {
  const i = key.lastIndexOf("/");
  const attempt = Number(key.slice(i + 1));
  if (i < 0 || !Number.isInteger(attempt)) return { step: key, attempt: 1 };
  return { step: key.slice(0, i), attempt };
}

export interface StepRecord {
  step: StepKey;
  status: "running" | "completed" | "failed" | "interrupted";
  attempts: number;        // counted attempts (interrupted ones excluded)
  interruptions: number;
  lastAttempt: number;
  inputsHash?: string;
  outputs: string[];
  treeSha?: string;
  data?: Record<string, unknown>;
  failureSignatures: string[];
}

export interface OpenCard {
  cardId: string;
  kind: string;            // "question" | "approval" | "unlock" | "park" | ...
  artifactSha: string;     // decisions must quote a prefix of this
  step?: StepKey;
  deadline?: string;
  defaultDecision?: Record<string, unknown>;
}

export interface Decision {
  cardId: string;
  decision: string;
  by: string;
  artifactSha: string;
  data?: Record<string, unknown>;
  seq: number;
}

export interface RunInfo {
  runId: string;
  mode: Mode;
  project: string;
  repoPath?: string;
  repoId?: string;
  baseRef?: string;
  baseCommit?: string;
  branch?: string;
  changeClass?: ChangeClass;
  complexity?: Complexity;
  request?: string;
  versions?: Record<string, string>;
  createdAt: string;
}

export interface RunState {
  info: RunInfo;
  status: RunStatus;
  steps: Map<StepKey, StepRecord>;
  inFlight?: { step: StepKey; attempt: number; seq: number };
  openCard?: OpenCard;
  decisions: Decision[];
  gates: { gateId: string; passed: boolean; step?: StepKey; inputsHash?: string; safety?: boolean; seq: number }[];
  costUsd: number;
  activeMs: number;
  waivers: number;
  rejections: number;
  pendingChanges: { seq: number; sha: string }[];
  parkedReason?: string;
  workspace?: { path: string; branch: string };
  lastSeq: number;
  flags: { pauseRequested: boolean; stopRequested: boolean };
  sinks: Map<string, { intentSeq: number; externalId?: string }>;
}

export function replay(events: LedgerEvent[]): RunState {
  const first = events[0];
  if (!first || first.type !== "run.created") throw new Error("Ledger must start with run.created");
  const d = (first.data ?? {}) as Partial<RunInfo>;
  const s: RunState = {
    info: { ...(d as RunInfo), runId: first.runId, createdAt: first.ts },
    status: "created",
    steps: new Map(),
    decisions: [],
    gates: [],
    costUsd: 0,
    activeMs: 0,
    waivers: 0,
    rejections: 0,
    pendingChanges: [],
    lastSeq: first.seq,
    flags: { pauseRequested: false, stopRequested: false },
    sinks: new Map(),
  };

  const rec = (step: StepKey): StepRecord => {
    let r = s.steps.get(step);
    if (!r) {
      r = { step, status: "running", attempts: 0, interruptions: 0, lastAttempt: 0, outputs: [], failureSignatures: [] };
      s.steps.set(step, r);
    }
    return r;
  };

  let startedAt: number | undefined;
  const closeActive = (ts: string) => {
    if (startedAt !== undefined) s.activeMs += Date.parse(ts) - startedAt;
    startedAt = undefined;
  };

  for (const ev of events.slice(1)) {
    s.lastSeq = ev.seq;
    const data = ev.data ?? {};
    switch (ev.type) {
      case "step.started": {
        const { step, attempt } = splitKey(ev.key!);
        const r = rec(step);
        r.status = "running";
        r.attempts += 1;
        r.lastAttempt = attempt;
        s.inFlight = { step, attempt, seq: ev.seq };
        if (s.status !== "delivered") s.status = "running";
        if (startedAt === undefined) startedAt = Date.parse(ev.ts);
        break;
      }
      case "step.completed": {
        const { step } = splitKey(ev.key!);
        const r = rec(step);
        r.status = "completed";
        r.inputsHash = ev.inputsHash;
        r.outputs = ev.outputs ?? [];
        r.treeSha = ev.treeSha;
        r.data = data;
        s.inFlight = undefined;
        closeActive(ev.ts);
        break;
      }
      case "step.failed": {
        const { step } = splitKey(ev.key!);
        const r = rec(step);
        r.status = "failed";
        if (typeof data.signature === "string") r.failureSignatures.push(data.signature);
        s.inFlight = undefined;
        closeActive(ev.ts);
        break;
      }
      case "step.interrupted": {
        const { step } = splitKey(ev.key!);
        const r = rec(step);
        r.status = "interrupted";
        r.attempts -= 1; // interrupted attempts don't count toward the cap
        if (data.reason !== "waiting") r.interruptions += 1; // a human wait isn't a crash
        s.inFlight = undefined;
        startedAt = undefined; // crash time is unknown; don't count it
        break;
      }
      case "gate.result": {
        const g = data as { gateId: string; passed: boolean; safety?: boolean; waiver?: unknown; step?: string };
        s.gates.push({ gateId: g.gateId, passed: g.passed, step: g.step, inputsHash: ev.inputsHash, safety: g.safety, seq: ev.seq });
        break;
      }
      case "human.requested":
        s.openCard = data as unknown as OpenCard;
        s.status = "waiting";
        closeActive(ev.ts);
        break;
      case "human.decided": {
        const dec = { ...(data as unknown as Omit<Decision, "seq">), seq: ev.seq };
        s.decisions.push(dec);
        if (dec.decision === "waive") s.waivers += 1;
        if (dec.decision === "reject") s.rejections += 1;
        if (s.openCard && s.openCard.cardId === dec.cardId) {
          s.openCard = undefined;
          if (s.status === "waiting") s.status = "running";
        }
        break;
      }
      case "change.received":
        s.pendingChanges.push({ seq: ev.seq, sha: String(data.sha ?? "") });
        break;
      case "usage":
        s.costUsd += Number(data["gen_ai.usage.cost_usd"] ?? data.costUsd ?? 0);
        break;
      case "run.resumed":
        s.status = s.openCard ? "waiting" : "running";
        s.parkedReason = undefined;
        s.flags.pauseRequested = false;
        if (typeof data.appliedChanges === "number") s.pendingChanges = s.pendingChanges.slice(data.appliedChanges);
        break;
      case "run.pause-requested": s.flags.pauseRequested = true; break;
      case "run.paused": s.status = "paused"; s.flags.pauseRequested = false; closeActive(ev.ts); break;
      case "run.parked": s.status = "parked"; s.parkedReason = String(data.reason ?? ""); closeActive(ev.ts); break;
      case "run.stop-requested": s.flags.stopRequested = true; break;
      case "run.stopped": s.status = { closed: "stopped" }; closeActive(ev.ts); break;
      case "run.delivered": s.status = "delivered"; closeActive(ev.ts); break;
      case "run.closed": s.status = { closed: data.reason as "merged" | "pr-closed" | "not-reproduced" }; break;
      case "workspace.created": s.workspace = { path: String(data.path), branch: String(data.branch) }; break;
      case "workspace.removed": s.workspace = undefined; break;
      case "sink.intent": s.sinks.set(String(data.idempotencyKey), { intentSeq: ev.seq }); break;
      case "sink.done": {
        const k = String(data.idempotencyKey);
        s.sinks.set(k, { intentSeq: s.sinks.get(k)?.intentSeq ?? ev.seq, externalId: String(data.externalId ?? "") });
        break;
      }
      case "run.created":
        throw new Error(`run.created appears twice (seq ${ev.seq})`);
      default:
        break;
    }
  }
  return s;
}

/** A completed step whose inputsHash is unchanged is skipped on resume. */
export function canSkip(state: RunState, step: StepKey, inputsHash: string): boolean {
  const r = state.steps.get(step);
  return r?.status === "completed" && r.inputsHash === inputsHash;
}

/**
 * inputsHash = hash(input artifact shas, stage definition, prompt template version, model
 * [, taskStartSha for coding steps]). Versions are recorded in run.created, not hashed.
 */
export function inputsHash(parts: {
  inputs: string[];
  stageDef: unknown;
  templateVersion: string;
  model?: string;
  taskStartSha?: string;
}): string {
  return hashJson(parts);
}

export function isClosed(status: RunStatus): boolean {
  return typeof status === "object";
}

export function statusLabel(status: RunStatus): string {
  return typeof status === "object" ? `closed: ${status.closed}` : status;
}
