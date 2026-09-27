// One failure ladder (gate-engine §2.6). Checked in order; the first match wins.
export type FailureCategory = "safety" | "locked-test" | "rate-limit" | "other";

export interface AttemptRecord {
  category: FailureCategory;
  signature: string;          // normalised failure signature
  diffSha?: string;           // hash of the attempt's diff; same as previous = no change
  rung: number;               // rung this attempt ran at
  lockedFailedIds?: string[]; // locked tests that failed on this attempt
}

export type Rung = "retry" | "raise-effort" | "stronger-model" | "other-vendor";
export const RUNGS: Rung[] = ["retry", "raise-effort", "stronger-model", "other-vendor"];

export type LadderAction =
  | { action: "retry"; rung: number; reason: string }
  | { action: "a5-check"; testIds: string[]; reason: string }
  | { action: "backoff"; waitMs: number; reason: string }
  | { action: "park"; reason: string };

export interface LadderOptions {
  maxAttempts: number;              // 6
  attemptsPerRung: number;          // 2
  availableRungs: Set<Rung>;        // e.g. no other-vendor under localOnly
  backoffSpentMs: number;
  backoffCapMs: number;             // 15 min
  a5Done: Set<string>;              // locked tests already judged "code wrong"
}

export const DEFAULT_LADDER: Omit<LadderOptions, "availableRungs" | "backoffSpentMs" | "a5Done"> = {
  maxAttempts: 6, attemptsPerRung: 2, backoffCapMs: 15 * 60_000,
};

function nextAvailable(from: number, avail: Set<Rung>): number | undefined {
  for (let r = from; r < RUNGS.length; r++) if (avail.has(RUNGS[r]!)) return r;
  return undefined;
}

/** Decide what to do after the latest failed attempt. `history` is oldest first and counted attempts only. */
export function nextOnFailure(history: AttemptRecord[], o: LadderOptions): LadderAction {
  const last = history[history.length - 1];
  if (!last) throw new Error("nextOnFailure needs at least one attempt");
  const prev = history[history.length - 2];

  // 3. rate limit / outage: back off, not counted, then park
  if (last.category === "rate-limit") {
    if (o.backoffSpentMs >= o.backoffCapMs) return { action: "park", reason: "Model provider unavailable for 15 minutes" };
    const waitMs = Math.min(o.backoffCapMs - o.backoffSpentMs, 30_000 * 2 ** Math.min(5, history.filter((h) => h.category === "rate-limit").length - 1));
    return { action: "backoff", waitMs, reason: "Rate limit or outage" };
  }
  const counted = history.filter((h) => h.category !== "rate-limit");
  if (counted.length >= o.maxAttempts) return { action: "park", reason: `${counted.length} attempts used` };

  // 1. safety: retry once with the failure, second time park
  if (last.category === "safety") {
    const safetyCount = counted.filter((h) => h.category === "safety").length;
    if (safetyCount >= 2) return { action: "park", reason: `Safety check failed twice: ${last.signature}` };
    return { action: "retry", rung: last.rung, reason: `Safety check failed: ${last.signature}` };
  }

  // 2. the same locked test failed on 2 attempts → test-defect check (A5)
  if (last.category === "locked-test" && prev?.lockedFailedIds && last.lockedFailedIds) {
    const twice = last.lockedFailedIds.filter((id) => prev.lockedFailedIds!.includes(id) && !o.a5Done.has(id));
    if (twice.length) return { action: "a5-check", testIds: twice, reason: "The same locked test failed twice" };
  }

  // 4. anything else: climb the ladder
  const stuck = !!prev && (prev.signature === last.signature || (!!last.diffSha && prev.diffSha === last.diffSha));
  const atRung = counted.filter((h) => h.rung === last.rung).length;
  const move = stuck || atRung >= o.attemptsPerRung;
  const target = nextAvailable(move ? last.rung + 1 : last.rung, o.availableRungs);
  if (target === undefined) return { action: "park", reason: "Every retry option is used up" };
  return {
    action: "retry", rung: target,
    reason: stuck ? "Same failure again; escalating" : move ? "Escalating after repeated failures" : "Retrying with the failures",
  };
}

/** A normalised failure signature: strip numbers, paths, hex and whitespace noise. */
export function failureSignature(parts: string[]): string {
  return parts
    .map((p) => p.replace(/0x[0-9a-f]+|[0-9a-f]{7,}|\d+/gi, "#").replace(/\s+/g, " ").trim())
    .sort()
    .join(" | ")
    .slice(0, 500);
}
