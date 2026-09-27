// Side effects (run-manager §2.6): intent → look-up → create, so a crash never repeats one.
import type { Ledger, Writer } from "./ledger.js";

export interface Sink<T> {
  kind: string;
  idempotencyKey: string;
  /** Find the effect if it already happened (PR by head branch, comment by marker…). */
  lookup(): Promise<{ externalId: string; value: T } | undefined>;
  create(): Promise<{ externalId: string; value: T }>;
}

export async function runSink<T>(ledger: Ledger, writer: Writer, sink: Sink<T>): Promise<{ externalId: string; value: T; created: boolean }> {
  await ledger.append({ type: "sink.intent", data: { kind: sink.kind, idempotencyKey: sink.idempotencyKey } }, writer);
  const found = await sink.lookup();
  const result = found ? { ...found, created: false } : { ...(await sink.create()), created: true };
  await ledger.append({
    type: "sink.done",
    data: { kind: sink.kind, idempotencyKey: sink.idempotencyKey, externalId: result.externalId, created: result.created },
  }, writer);
  return result;
}
