// The ledger (run-manager §2.4): ~/.factory/ledger/<runId>/
//   events.jsonl        append-only, one JSON event per line, fsync after each append
//   artifacts/<sha256>  content-addressed, durable writes
//   cards/<cardId>.md   human cards as shown
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  truncateSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { LedgerEvent, type NewEvent } from "../contracts/index.js";
import { sha256, stableStringify } from "../util/hash.js";
import { fsyncDir, writeFileDurable } from "../util/fsx.js";
import { assertSupportedPath, paths } from "../util/paths.js";

export class LedgerCorruptError extends Error {}
export class FencedOutError extends Error {}

/** Who is writing. The executor passes its execution lock so stale executors are fenced out. */
export interface Writer {
  epoch(): number;
  /** Throws FencedOutError when this writer's epoch is no longer current. */
  assertCurrent?(): void;
}

export const HUMAN_WRITER: Writer = { epoch: () => 0 };

function tryParse(line: string): LedgerEvent | undefined {
  try {
    return LedgerEvent.parse(JSON.parse(line));
  } catch {
    return undefined;
  }
}

export class Ledger {
  readonly eventsPath: string;
  readonly artifactsDir: string;
  readonly cardsDir: string;

  private constructor(readonly dir: string, readonly runId: string) {
    this.eventsPath = join(dir, "events.jsonl");
    this.artifactsDir = join(dir, "artifacts");
    this.cardsDir = join(dir, "cards");
  }

  static exists(runId: string): boolean {
    return existsSync(join(paths.ledger(runId), "events.jsonl"));
  }

  /** Create the folder for a new run. The caller appends run.created. */
  static create(runId: string, dir = paths.ledger(runId)): Ledger {
    assertSupportedPath(dir);
    if (existsSync(join(dir, "events.jsonl"))) throw new Error(`Run ${runId} already exists`);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    mkdirSync(join(dir, "cards"), { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "", { mode: 0o600 });
    fsyncDir(dir);
    return new Ledger(dir, runId);
  }

  static open(runId: string, dir = paths.ledger(runId)): Ledger {
    if (!existsSync(join(dir, "events.jsonl"))) throw new Error(`No run ${runId}`);
    return new Ledger(dir, runId);
  }

  static listRuns(): string[] {
    const root = join(paths.ledger("x"), "..");
    if (!existsSync(root)) return [];
    return readdirSync(root).filter((d) => existsSync(join(root, d, "events.jsonl"))).sort();
  }

  // ---------- events ----------

  /** All events. Throws on corruption anywhere except a torn last line (repaired on append). */
  events(): LedgerEvent[] {
    return this.parse().events;
  }

  private parse(): { events: LedgerEvent[]; tornAt?: number } {
    const raw = readFileSync(this.eventsPath, "utf8");
    if (raw === "") return { events: [] };
    const endsClean = raw.endsWith("\n");
    const lines = (endsClean ? raw.slice(0, -1) : raw).split("\n");
    const events: LedgerEvent[] = [];
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const isLast = i === lines.length - 1;
      // a last line without its newline is a torn write, even if it happens to parse
      const ev = isLast && !endsClean ? undefined : tryParse(line);
      if (!ev) {
        if (isLast) return { events, tornAt: offset };
        throw new LedgerCorruptError(`Bad line ${i + 1} in ${this.eventsPath}`);
      }
      events.push(ev);
      offset += Buffer.byteLength(line) + 1;
    }
    return { events };
  }

  /**
   * Append one event under the per-run ledger lock, then fsync.
   * A torn last line is truncated and `ledger.repaired` is appended first.
   */
  async append(ev: NewEvent, writer: Writer): Promise<LedgerEvent> {
    const out = await this.appendIf(() => ev, writer);
    return out!;
  }

  /**
   * Under the ledger lock: read all events, let `decide` build the event (or return
   * undefined to write nothing), then append it. Used for hash checks under the lock.
   */
  async appendIf(decide: (events: LedgerEvent[]) => NewEvent | undefined, writer: Writer): Promise<LedgerEvent | undefined> {
    const release = await lockfile.lock(this.eventsPath, {
      realpath: false, stale: 10_000, retries: { retries: 50, minTimeout: 20, maxTimeout: 200 },
    });
    try {
      writer.assertCurrent?.();
      let { events, tornAt } = this.parse();
      if (tornAt !== undefined) {
        truncateSync(this.eventsPath, tornAt);
        const repaired = this.write(events, { type: "ledger.repaired", data: { truncatedAt: tornAt } }, writer);
        events = [...events, repaired];
      }
      const ev = decide(events);
      return ev ? this.write(events, ev, writer) : undefined;
    } finally {
      await release();
    }
  }

  private write(existing: LedgerEvent[], ev: NewEvent, writer: Writer): LedgerEvent {
    const last = existing[existing.length - 1];
    const full = LedgerEvent.parse({
      ...ev,
      seq: last ? last.seq + 1 : 0,
      ts: new Date().toISOString(),
      runId: this.runId,
      epoch: writer.epoch(),
    });
    appendFileSync(this.eventsPath, JSON.stringify(full) + "\n");
    const fd = openSync(this.eventsPath, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return full;
  }

  // ---------- artifacts ----------

  putArtifact(content: string | Uint8Array): string {
    const buf = typeof content === "string" ? Buffer.from(content) : content;
    const sha = sha256(buf);
    const p = join(this.artifactsDir, sha);
    if (!existsSync(p)) writeFileDurable(p, buf);
    return sha;
  }

  /** Stable JSON so the same value always gets the same sha. */
  putJson(value: unknown): string {
    return this.putArtifact(stableStringify(value));
  }

  hasArtifact(sha: string): boolean {
    return existsSync(join(this.artifactsDir, sha));
  }

  getArtifact(sha: string): Buffer {
    const buf = readFileSync(join(this.artifactsDir, sha));
    if (sha256(buf) !== sha) throw new LedgerCorruptError(`Artifact ${sha} does not match its hash`);
    return buf;
  }

  getJson<T = unknown>(sha: string): T {
    return JSON.parse(this.getArtifact(sha).toString("utf8")) as T;
  }

  // ---------- cards ----------

  writeCard(cardId: string, markdown: string): string {
    writeFileDurable(join(this.cardsDir, `${cardId}.md`), markdown);
    return this.putArtifact(markdown);
  }

  readCard(cardId: string): string {
    return readFileSync(join(this.cardsDir, `${cardId}.md`), "utf8");
  }
}
