// Step scorecard: how each step did in a run, and across runs. Computed only from the ledger
// (no model calls, no cost). `factory report <run>` / `factory report --all`.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "./ledger/ledger.js";
import { replay, splitKey, statusLabel, type RunState } from "./ledger/state.js";

export interface StepScore {
  step: string;
  /** "implement/TASK-2" → "implement", for comparing across runs */
  stage: string;
  outcome: string;
  firstTimePass: boolean;
  attempts: number;
  interruptions: number;
  retryReasons: string[];
  highestRung: number;
  models: string[];
  tokens: { input: number; output: number; cached: number };
  costUsd: number;
  activeSec: number;
  gates: { passed: number; failed: number; failedIds: string[] };
  human: { cards: number; decisions: string[]; answersChanged?: number; questionsAsked?: number };
}

export interface RunScore {
  runId: string;
  status: string;
  parkedReason?: string;
  request: string;
  costUsd: number;
  activeMin: number;
  firstTimePassRate: number;
  topCost: { step: string; costUsd: number }[];
  steps: StepScore[];
}

export function stageOf(step: string): string {
  return step.split("/")[0]!;
}

export function scoreRun(ledger: Ledger): RunScore {
  const events = ledger.events();
  const state: RunState = replay(events);
  const scores = new Map<string, StepScore>();
  const get = (step: string): StepScore => {
    let s = scores.get(step);
    if (!s) {
      s = {
        step, stage: stageOf(step), outcome: "pending", firstTimePass: false, attempts: 0, interruptions: 0, retryReasons: [],
        highestRung: 0, models: [], tokens: { input: 0, output: 0, cached: 0 }, costUsd: 0, activeSec: 0,
        gates: { passed: 0, failed: 0, failedIds: [] }, human: { cards: 0, decisions: [] },
      };
      scores.set(step, s);
    }
    return s;
  };
  const openAttempts = new Map<string, number>(); // "step/attempt" → start ms
  const cardStep = new Map<string, string>();      // cardId → step

  for (const ev of events) {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    const k = ev.key ? splitKey(ev.key) : undefined;
    switch (ev.type) {
      case "step.started":
        if (k) { openAttempts.set(ev.key!, Date.parse(ev.ts)); get(k.step).highestRung = Math.max(get(k.step).highestRung, Number(d.rung ?? 0)); }
        break;
      case "step.completed": case "step.failed": case "step.interrupted": {
        if (!k) break;
        const t0 = openAttempts.get(ev.key!);
        if (t0 !== undefined) { get(k.step).activeSec += (Date.parse(ev.ts) - t0) / 1000; openAttempts.delete(ev.key!); }
        if (ev.type === "step.failed" && !d.parked) get(k.step).retryReasons.push(String(d.reason ?? d.signature ?? d.category ?? "failed").slice(0, 160));
        break;
      }
      case "usage": {
        if (!k) break;
        const s = get(k.step);
        const m = String(d["gen_ai.request.model"] ?? "");
        if (m && !s.models.includes(m)) s.models.push(m);
        s.tokens.input += Number(d["gen_ai.usage.input_tokens"] ?? 0);
        s.tokens.output += Number(d["gen_ai.usage.output_tokens"] ?? 0);
        s.tokens.cached += Number(d["gen_ai.usage.cache_read_tokens"] ?? 0);
        s.costUsd += Number(d["gen_ai.usage.cost_usd"] ?? 0);
        break;
      }
      case "gate.result": {
        const step = typeof d.step === "string" ? d.step : ev.key;
        if (!step) break;
        const g = get(step).gates;
        if (d.passed) g.passed++; else { g.failed++; g.failedIds.push(String(d.gateId)); }
        break;
      }
      case "human.requested":
        if (typeof d.step === "string") { cardStep.set(String(d.cardId), d.step); get(d.step).human.cards++; }
        break;
      case "human.decided": {
        const step = cardStep.get(String(d.cardId));
        if (step) get(step).human.decisions.push(`${d.decision}${d.by === "default-timeout" ? " (timeout)" : ""}`);
        break;
      }
      default: break;
    }
  }

  // outcomes and first-time pass from the replayed state
  for (const r of state.steps.values()) {
    const s = get(r.step);
    s.outcome = r.status;
    s.attempts = r.attempts;
    s.interruptions = r.interruptions;
    s.firstTimePass = r.status === "completed" && s.retryReasons.length === 0;
  }

  // clarify: how many questions were asked, and how many answers differed from the recommendation
  for (const step of ["clarify", "clarify-2"]) {
    const sha = state.steps.get(step)?.outputs[0];
    if (!sha || !ledger.hasArtifact(sha)) continue;
    const c = ledger.getJson<{ asked?: { id: string; recommended: string }[]; answers?: Record<string, string> }>(sha);
    const asked = c.asked ?? [];
    get(step).human.questionsAsked = asked.length;
    get(step).human.answersChanged = asked.filter((q) => c.answers?.[q.id] !== undefined && c.answers[q.id] !== q.recommended).length;
  }

  const steps = [...scores.values()].filter((s) => s.attempts > 0 || s.costUsd > 0 || s.human.cards > 0);
  const done = steps.filter((s) => s.outcome === "completed");
  return {
    runId: state.info.runId,
    status: statusLabel(state.status),
    parkedReason: state.parkedReason,
    request: (state.info.request ?? "").slice(0, 200),
    costUsd: state.costUsd,
    activeMin: state.activeMs / 60_000,
    firstTimePassRate: done.length ? done.filter((s) => s.firstTimePass).length / done.length : 0,
    topCost: [...steps].sort((a, b) => b.costUsd - a.costUsd).slice(0, 3).filter((s) => s.costUsd > 0).map((s) => ({ step: s.step, costUsd: s.costUsd })),
    steps,
  };
}

export function saveReport(ledger: Ledger): RunScore {
  const r = scoreRun(ledger);
  try { writeFileSync(join(ledger.dir, "report.json"), JSON.stringify(r, null, 2)); } catch { /* best effort */ }
  return r;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const kTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));

export function formatRun(r: RunScore): string {
  const lines = [
    `Run ${r.runId}: ${r.status}${r.parkedReason ? ` (${r.parkedReason})` : ""}`,
    `Request: ${r.request}`,
    `Cost ${money(r.costUsd)} · active ${r.activeMin.toFixed(1)} min · first-time pass ${(r.firstTimePassRate * 100).toFixed(0)}% of finished steps`,
    r.topCost.length ? `Most expensive: ${r.topCost.map((t) => `${t.step} ${money(t.costUsd)}`).join(", ")}` : "",
    "",
    `${"step".padEnd(20)} ${"outcome".padEnd(11)} ${"1st?".padEnd(5)} ${"tries".padEnd(5)} ${"cost".padStart(7)} ${"time".padStart(7)} ${"tokens in/out".padStart(14)}  gates  notes`,
  ];
  for (const s of r.steps) {
    const notes = [
      s.highestRung ? `rung ${s.highestRung}` : "",
      s.gates.failedIds.length ? `failed: ${[...new Set(s.gates.failedIds)].join(",")}` : "",
      s.human.questionsAsked ? `${s.human.questionsAsked} questions, ${s.human.answersChanged ?? 0} answers ≠ recommended` : "",
      s.human.decisions.length ? `you: ${s.human.decisions.join(", ")}` : "",
      s.retryReasons.length ? `why retried: ${s.retryReasons[0]}` : "",
    ].filter(Boolean).join("; ");
    lines.push(`${s.step.padEnd(20)} ${s.outcome.padEnd(11)} ${(s.firstTimePass ? "yes" : "no").padEnd(5)} ${String(s.attempts).padEnd(5)} ${money(s.costUsd).padStart(7)} ${`${Math.round(s.activeSec)}s`.padStart(7)} ${`${kTok(s.tokens.input + s.tokens.cached)}/${kTok(s.tokens.output)}`.padStart(14)}  ${`${s.gates.passed}✓${s.gates.failed ? ` ${s.gates.failed}✗` : ""}`.padEnd(6)} ${notes}`);
  }
  return lines.filter((l, i) => l !== "" || i === 4).join("\n");
}

/** Across runs, per stage: how often it passes first time, what it costs, what breaks it. */
export function formatAll(runs: RunScore[]): string {
  const by = new Map<string, StepScore[]>();
  for (const r of runs) for (const s of r.steps) by.set(s.stage, [...(by.get(s.stage) ?? []), s]);
  const lines = [
    `${runs.length} runs · total ${money(runs.reduce((n, r) => n + r.costUsd, 0))}`,
    "",
    `${"stage".padEnd(16)} ${"runs".padEnd(5)} ${"1st-pass".padEnd(9)} ${"avg cost".padStart(9)} ${"avg time".padStart(9)}  most common problem`,
  ];
  for (const [stage, ss] of [...by.entries()].sort((a, b) => b[1].reduce((n, s) => n + s.costUsd, 0) - a[1].reduce((n, s) => n + s.costUsd, 0))) {
    const done = ss.filter((s) => s.outcome === "completed");
    const reasons = ss.flatMap((s) => [...s.gates.failedIds, ...s.retryReasons.map((r) => r.split(":")[0]!)]);
    const top = [...new Set(reasons)].map((r) => [r, reasons.filter((x) => x === r).length] as const).sort((a, b) => b[1] - a[1])[0];
    lines.push(`${stage.padEnd(16)} ${String(ss.length).padEnd(5)} ${`${done.length ? Math.round((done.filter((s) => s.firstTimePass).length / done.length) * 100) : 0}%`.padEnd(9)} ${money(ss.reduce((n, s) => n + s.costUsd, 0) / ss.length).padStart(9)} ${`${Math.round(ss.reduce((n, s) => n + s.activeSec, 0) / ss.length)}s`.padStart(9)}  ${top ? `${top[0]} (${top[1]}×)` : "-"}`);
  }
  return lines.join("\n");
}
