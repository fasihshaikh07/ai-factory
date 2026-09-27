// Execution lock, one per repo (run-manager §2.9).
// proper-lockfile on ~/.factory/locks/<key>, stale after 60 s without a heartbeat.
// Every takeover increments `epoch`, a fencing token written on every event.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { writeFileDurable } from "../util/fsx.js";
import { paths } from "../util/paths.js";
import { FencedOutError, type Writer } from "./ledger.js";

export interface LockInfo { runId: string; pid: number; host: string; startedAt: string; epoch: number }

export class LockBusyError extends Error {
  constructor(readonly holder: LockInfo | undefined) {
    super(holder ? `Repo is busy: run ${holder.runId} is executing (pid ${holder.pid})` : "Repo is busy");
  }
}

const STALE_MS = 60_000;

function lockPath(key: string): string {
  return join(paths.locks(), key.replace(/[^A-Za-z0-9._:-]/g, "_"));
}

export function readLockInfo(key: string): LockInfo | undefined {
  const p = lockPath(key);
  if (!existsSync(p)) return undefined;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as LockInfo;
  } catch {
    return undefined;
  }
}

/** True when nobody holds the lock (or the holder went stale). */
export async function isLockFree(key: string): Promise<boolean> {
  const p = lockPath(key);
  if (!existsSync(p)) return true;
  return !(await lockfile.check(p, { realpath: false, stale: STALE_MS }));
}

export class ExecutionLock implements Writer {
  private released = false;
  private compromised?: Error;

  private constructor(
    readonly key: string,
    readonly info: LockInfo,
    private readonly releaseFn: () => Promise<void>,
  ) {}

  static async acquire(key: string, runId: string, opts: { onCompromised?: (e: Error) => void } = {}): Promise<ExecutionLock> {
    mkdirSync(paths.locks(), { recursive: true });
    const p = lockPath(key);
    if (!existsSync(p)) writeFileDurable(p, JSON.stringify({ runId: "", pid: 0, host: "", startedAt: "", epoch: 0 }));
    let holder: ExecutionLock | undefined;
    let release: () => Promise<void>;
    try {
      release = await lockfile.lock(p, {
        realpath: false,
        stale: STALE_MS,
        update: STALE_MS / 4,
        onCompromised: (err) => {
          if (holder) holder.compromised = err;
          opts.onCompromised?.(err);
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code === "ELOCKED") throw new LockBusyError(readLockInfo(key));
      throw e;
    }
    const prev = readLockInfo(key);
    const info: LockInfo = {
      runId, pid: process.pid, host: hostname(), startedAt: new Date().toISOString(),
      epoch: (prev?.epoch ?? 0) + 1,
    };
    writeFileDurable(p, JSON.stringify(info));
    holder = new ExecutionLock(key, info, release);
    return holder;
  }

  epoch(): number {
    return this.info.epoch;
  }

  /** Refuse to write if another executor took over since we acquired the lock. */
  assertCurrent(): void {
    if (this.released) throw new FencedOutError("Execution lock already released");
    if (this.compromised) throw new FencedOutError(`Execution lock lost: ${this.compromised.message}`);
    const now = readLockInfo(this.key);
    if (!now || now.epoch !== this.info.epoch) {
      throw new FencedOutError(`Fenced out: lock epoch is ${now?.epoch}, ours is ${this.info.epoch}`);
    }
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      await this.releaseFn();
    } catch {
      // already released or compromised; nothing to do
    }
  }
}
