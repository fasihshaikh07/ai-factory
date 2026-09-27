// Gate engine core (gate-engine §2.1): pure predicates over ledger artifacts.
// Producers (build, tests, scans) run elsewhere and store their outputs; gates only read them.
import type { Failure, GateResult, StageName } from "../contracts/index.js";
import { GateResult as GateResultSchema } from "../contracts/index.js";
import { hashJson } from "../util/hash.js";
import type { Ledger, Writer } from "../ledger/ledger.js";
import type { Policy } from "./policy.js";

export interface Verdict { passed: boolean; details: string; failures?: Failure[] }

export interface GateDef<I = any> {
  id: string;
  after: StageName;
  /** Safety gates can't be waived and take rung 1 of the failure ladder. */
  safety: boolean;
  waiver: "none" | "human";
  predicate: (input: I, policy: Policy) => Verdict;
}

/** Inputs by name → artifact sha. The values are loaded from the ledger. */
export type GateInputs = Record<string, string>;

const registry = new Map<string, GateDef>();

export function defineGate<I>(def: GateDef<I>): GateDef<I> {
  if (registry.has(def.id)) throw new Error(`Gate ${def.id} defined twice`);
  registry.set(def.id, def as GateDef);
  return def;
}

export function getGate(id: string): GateDef | undefined {
  return registry.get(id);
}

export function gateInputsHash(gateId: string, inputs: GateInputs, policy: Policy): string {
  return hashJson({ gateId, inputs, policy });
}

function loadInputs(ledger: Ledger, inputs: GateInputs): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, sha] of Object.entries(inputs)) out[name] = ledger.getJson(sha);
  return out;
}

/** Evaluate a gate on artifacts stored in the ledger. Pure: same inputs → same result. */
export function evaluate(def: GateDef, ledger: Ledger, inputs: GateInputs, policy: Policy, treeSha?: string): GateResult {
  const verdict = def.predicate(loadInputs(ledger, inputs), policy);
  return GateResultSchema.parse({
    gateId: def.id,
    passed: verdict.passed,
    details: verdict.details,
    failures: verdict.failures,
    safety: def.safety,
    inputsHash: gateInputsHash(def.id, inputs, policy),
    treeSha,
  });
}

/** Evaluate and record `gate.result` with everything verify-evidence needs to re-check it. */
export async function runGate(
  def: GateDef, ledger: Ledger, writer: Writer, inputs: GateInputs, policy: Policy,
  ctx: { step: string; treeSha?: string },
): Promise<GateResult> {
  const result = evaluate(def, ledger, inputs, policy, ctx.treeSha);
  const policySha = ledger.putJson(policy);
  const resultSha = ledger.putJson(result);
  await ledger.append({
    type: "gate.result",
    key: ctx.step,
    inputsHash: result.inputsHash,
    treeSha: ctx.treeSha,
    outputs: [resultSha],
    data: { gateId: def.id, passed: result.passed, safety: def.safety, step: ctx.step, inputs, policySha, details: result.details.slice(0, 500) },
  }, writer);
  return result;
}

export interface EvidenceCheck { gateId: string; seq: number; ok: boolean; reason?: string }

/**
 * `factory verify-evidence`: re-hash the ledger files and re-run every predicate.
 * It doesn't re-execute tests or scans; those are recorded evidence.
 */
export function verifyEvidence(ledger: Ledger): EvidenceCheck[] {
  const out: EvidenceCheck[] = [];
  for (const ev of ledger.events()) {
    if (ev.type !== "gate.result") continue;
    const d = ev.data as { gateId: string; passed: boolean; inputs: GateInputs; policySha: string };
    const def = getGate(d.gateId);
    if (!def) { out.push({ gateId: d.gateId, seq: ev.seq, ok: false, reason: "unknown gate" }); continue; }
    try {
      const policy = ledger.getJson<Policy>(d.policySha);
      const again = evaluate(def, ledger, d.inputs, policy, ev.treeSha);
      const ok = again.passed === d.passed && again.inputsHash === ev.inputsHash;
      out.push({ gateId: d.gateId, seq: ev.seq, ok, reason: ok ? undefined : "decision differs from the recorded one" });
    } catch (e) {
      out.push({ gateId: d.gateId, seq: ev.seq, ok: false, reason: (e as Error).message });
    }
  }
  return out;
}

export function failure(check: string, message: string, extra: Partial<Failure> = {}): Failure {
  return { check, message, frames: [], ...extra };
}

export function verdict(failures: Failure[], okText: string): Verdict {
  return failures.length
    ? { passed: false, details: failures.slice(0, 5).map((f) => f.message).join("; "), failures }
    : { passed: true, details: okText };
}

// Test hook: gates register at import time; tests may need a fresh registry for ad-hoc gates.
export function _unregister(id: string): void {
  registry.delete(id);
}
