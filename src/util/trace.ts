// Run trace: where is a run, and where did it get stuck? Two files in the run's ledger folder:
//   trace.jsonl  one JSON event per line (for tools and `factory logs --full`)
//   run.log      the same, readable
// Everything is secret-masked before it's written. Local only, like the rest of the ledger.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { maskSecrets } from "../config/env.js";
import { Redactor } from "../context/secrets.js";

export interface TraceEvent {
  ts: string;
  elapsedMs: number;
  step?: string;
  attempt?: number;
  kind: string;
  msg: string;
  data?: Record<string, unknown>;
}

export interface Trace {
  event(kind: string, msg: string, data?: Record<string, unknown>): void;
  /** Save a large masked blob (a full model turn, a log tail) and return its sha. */
  blob(content: string): string | undefined;
  setStep(step?: string, attempt?: number): void;
}

export const NO_TRACE: Trace = { event() {}, blob: () => undefined, setStep() {} };

function hms(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

export function fmtElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `+${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `+${m}m${String(s % 60).padStart(2, "0")}s`;
  return `+${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

export function formatLine(e: TraceEvent): string {
  const where = e.step ? `${e.step}${e.attempt ? `#${e.attempt}` : ""}` : "run";
  return `${hms(new Date(e.ts))} ${fmtElapsed(e.elapsedMs).padStart(8)}  ${where.padEnd(22)} ${e.msg}`;
}

export class Tracer implements Trace {
  private readonly started = Date.now();
  private readonly redactor = new Redactor();
  private step?: string;
  private attempt?: number;
  private timer?: NodeJS.Timeout;
  /** the last real activity (heartbeats don't count) */
  last: { msg: string; at: number } = { msg: "starting", at: Date.now() };

  constructor(
    private readonly dir: string,
    private readonly opts: { echo?: (line: string) => void; putBlob?: (content: string) => string } = {},
  ) {}

  private mask(text: string): string {
    return this.redactor.redact(maskSecrets(text)).text;
  }

  setStep(step?: string, attempt?: number): void {
    this.step = step;
    this.attempt = attempt;
  }

  event(kind: string, msg: string, data?: Record<string, unknown>): void {
    const e: TraceEvent = {
      ts: new Date().toISOString(), elapsedMs: Date.now() - this.started, step: this.step, attempt: this.attempt,
      kind, msg: this.mask(msg), ...(data ? { data: JSON.parse(this.mask(JSON.stringify(data))) as Record<string, unknown> } : {}),
    };
    try {
      appendFileSync(join(this.dir, "trace.jsonl"), JSON.stringify(e) + "\n");
      appendFileSync(join(this.dir, "run.log"), formatLine(e) + "\n");
    } catch {
      // tracing must never break a run
    }
    if (kind !== "heartbeat") this.last = { msg: e.msg, at: Date.now() };
    if (kind !== "heartbeat" && kind !== "model.turn.detail") this.opts.echo?.(e.msg);
  }

  blob(content: string): string | undefined {
    return this.opts.putBlob?.(this.mask(content));
  }

  /** Every interval, write "still in <last activity> for Xm" so a stuck run is visible. */
  startHeartbeat(intervalMs = 60_000): void {
    this.stopHeartbeat();
    this.timer = setInterval(() => {
      const idle = Date.now() - this.last.at;
      if (idle >= intervalMs) this.event("heartbeat", `still waiting on: ${this.last.msg} (${Math.round(idle / 60_000)} min, no new activity)`);
    }, intervalMs);
    this.timer.unref();
  }

  stopHeartbeat(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

export function readTrace(dir: string): TraceEvent[] {
  const f = join(dir, "trace.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as TraceEvent]; } catch { return []; }
  });
}

/** The last real activity of a run (for `factory status`). */
export function lastActivity(dir: string): TraceEvent | undefined {
  return [...readTrace(dir)].reverse().find((e) => e.kind !== "heartbeat");
}

/** Short one-line summary of tool arguments. */
export function argsSummary(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const main = o.path ?? o.file_path ?? o.pattern ?? o.command ?? o.focus;
  const s = typeof main === "string" ? main : JSON.stringify(main ?? o);
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}
