// Human decisions (run-manager §2.7, gate-engine §2.3, §2.7).
// `factory approve|reject|answer|waive|unlock <run> <hash-prefix>`: TTY only, hash checked
// under the ledger lock, identical repeats are no-ops.
import { userInfo } from "node:os";
import type { HumanDecision, LedgerEvent } from "../contracts/index.js";
import { HUMAN_WRITER, type Ledger } from "./ledger.js";
import { replay } from "./state.js";

export class DecisionError extends Error {}

export const MIN_PREFIX = 4;

export function assertTty(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new DecisionError("Decisions can only be made from a terminal, not from a script or a plugin.");
  }
}

export interface DecideInput {
  decision: HumanDecision;
  hashPrefix: string;
  by?: string;
  data?: Record<string, unknown>;
}

export type DecideOutcome = { kind: "recorded"; event: LedgerEvent } | { kind: "repeat" };

export async function decide(ledger: Ledger, input: DecideInput): Promise<DecideOutcome> {
  const prefix = input.hashPrefix.toLowerCase();
  if (prefix.length < MIN_PREFIX) throw new DecisionError(`Use at least ${MIN_PREFIX} characters of the hash.`);
  if (input.decision === "reject" && !String(input.data?.reason ?? "").trim()) {
    throw new DecisionError("A rejection needs a reason.");
  }
  const by = input.by ?? userInfo().username;
  let repeat = false;
  const ev = await ledger.appendIf((events) => {
    const state = replay(events);
    const card = state.openCard;
    if (!card) {
      const last = state.decisions[state.decisions.length - 1];
      if (last && last.decision === input.decision && last.artifactSha.startsWith(prefix)) {
        repeat = true;
        return undefined;
      }
      throw new DecisionError("There is no open card on this run.");
    }
    if (!card.artifactSha.startsWith(prefix)) {
      throw new DecisionError(
        `Hash ${prefix} doesn't match the open card (${card.artifactSha.slice(0, 8)}). The card may have changed; run \`factory show-card\`.`,
      );
    }
    return {
      type: "human.decided",
      data: { cardId: card.cardId, decision: input.decision, by, artifactSha: card.artifactSha, ...(input.data ?? {}) },
    };
  }, HUMAN_WRITER);
  return repeat || !ev ? { kind: "repeat" } : { kind: "recorded", event: ev };
}

/**
 * Deadlines: any command that finds an expired deadline appends the default decision.
 * It never starts execution (run-manager §2.7).
 */
export async function applyExpiredDeadline(ledger: Ledger, now = new Date()): Promise<boolean> {
  const ev = await ledger.appendIf((events) => {
    const card = replay(events).openCard;
    if (!card?.deadline || !card.defaultDecision || Date.parse(card.deadline) > now.getTime()) return undefined;
    return {
      type: "human.decided",
      data: { cardId: card.cardId, decision: "answer", by: "default-timeout", artifactSha: card.artifactSha, ...card.defaultDecision },
    };
  }, HUMAN_WRITER);
  return ev !== undefined;
}
