// Step scorecard: how each step did in a run, and across runs. Computed only from the ledger
// (no model calls, no cost). `factory report <run>` / `factory report --all`.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Ledger } from "./ledger/ledger.js";
import { replay, splitKey, statusLabel, type RunState } from "./ledger/state.js";
import { readTrace, type TraceEvent } from "./util/trace.js";

/**
 * Per step, seconds spent in model calls, in the coding agent's container, and in the test lab.
 * Model time is the sum of turn durations; agent time runs from "agent started" to "agent finished";
 * lab time adds up the durations each lab phase reports ("lab: build ok (62s)").
 */
export function timeSplit(trace: TraceEvent[]): Map<string, { modelSec: number; agentSec: number; labSec: number }> {
  const out = new Map<string, { modelSec: number; agentSec: number; labSec: number }>();
  const get = (step: string) => { let t = out.get(step); if (!t) { t = { modelSec: 0, agentSec: 0, labSec: 0 }; out.set(step, t); } return t; };
  const agentStart = new Map<string, number>();
  for (const e of trace) {
    if (!e.step) continue;
    const t = get(e.step);
    if (e.kind === "model.turn") t.modelSec += Number(e.data?.ms ?? 0) / 1000;
    else if (e.kind === "agent.start") agentStart.set(e.step, Date.parse(e.ts));
    else if (e.kind === "agent.end" && agentStart.has(e.step)) { t.agentSec += (Date.parse(e.ts) - agentStart.get(e.step)!) / 1000; agentStart.delete(e.step); }
    else if (e.kind.startsWith("lab.")) { const m = /\((\d+)s\)/.exec(e.msg); if (m) t.labSec += Number(m[1]); }
  }
  return out;
}

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
  /** where the step's time went, from the run trace: model calls, the coding agent's container, the test lab */
  time?: { modelSec: number; agentSec: number; labSec: number };
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
  /** run.created time */
  createdAt?: string;
  /** first run.delivered time */
  deliveredAt?: string;
  /** kind of every card a human was asked (question, approval, cap, ...), once per card */
  humanCards?: string[];
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
  const cardKinds = new Map<string, string>();     // cardId → kind, every card incl. cap cards
  let deliveredAt: string | undefined;

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
      case "run.delivered": deliveredAt ??= ev.ts; break;
      case "human.requested":
        if (!cardKinds.has(String(d.cardId))) cardKinds.set(String(d.cardId), String(d.kind ?? "other"));
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
  let split = new Map<string, { modelSec: number; agentSec: number; labSec: number }>();
  try { split = timeSplit(readTrace(ledger.dir)); } catch { /* no trace: no split */ }
  for (const s of steps) { const t = split.get(s.step); if (t && (t.modelSec || t.agentSec || t.labSec)) s.time = { modelSec: Math.round(t.modelSec), agentSec: Math.round(t.agentSec), labSec: Math.round(t.labSec) }; }
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
    createdAt: state.info.createdAt,
    deliveredAt,
    humanCards: [...cardKinds.values()],
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
    `${"step".padEnd(20)} ${"outcome".padEnd(11)} ${"1st?".padEnd(5)} ${"tries".padEnd(5)} ${"cost".padStart(7)} ${"time".padStart(7)} ${"model/agent/lab".padStart(16)} ${"tokens in/out".padStart(14)}  gates  notes`,
  ];
  for (const s of r.steps) {
    const notes = [
      s.highestRung ? `rung ${s.highestRung}` : "",
      s.gates.failedIds.length ? `failed: ${[...new Set(s.gates.failedIds)].join(",")}` : "",
      s.human.questionsAsked ? `${s.human.questionsAsked} questions, ${s.human.answersChanged ?? 0} answers ≠ recommended` : "",
      s.human.decisions.length ? `you: ${s.human.decisions.join(", ")}` : "",
      s.retryReasons.length ? `why retried: ${s.retryReasons[0]}` : "",
    ].filter(Boolean).join("; ");
    lines.push(`${s.step.padEnd(20)} ${s.outcome.padEnd(11)} ${(s.firstTimePass ? "yes" : "no").padEnd(5)} ${String(s.attempts).padEnd(5)} ${money(s.costUsd).padStart(7)} ${`${Math.round(s.activeSec)}s`.padStart(7)} ${(s.time ? `${s.time.modelSec}/${s.time.agentSec}/${s.time.labSec}s` : "-").padStart(16)} ${`${kTok(s.tokens.input + s.tokens.cached)}/${kTok(s.tokens.output)}`.padStart(14)}  ${`${s.gates.passed}✓${s.gates.failed ? ` ${s.gates.failed}✗` : ""}`.padEnd(6)} ${notes}`);
  }
  return lines.filter((l, i) => l !== "" || i === 4).join("\n");
}

export interface StageStats {
  stage: string;
  /** step instances across runs ("implement" counts once per task) */
  count: number;
  /** completed first time ÷ completed; 0 when none completed */
  firstTimePassRate: number;
  avgCostUsd: number;
  avgActiveSec: number;
  topProblem?: { reason: string; count: number };
}

/** Per stage across runs, most expensive first. */
export function stageStats(runs: RunScore[]): StageStats[] {
  const by = new Map<string, StepScore[]>();
  for (const r of runs) for (const s of r.steps) by.set(s.stage, [...(by.get(s.stage) ?? []), s]);
  return [...by.entries()].sort((a, b) => b[1].reduce((n, s) => n + s.costUsd, 0) - a[1].reduce((n, s) => n + s.costUsd, 0)).map(([stage, ss]) => {
    const done = ss.filter((s) => s.outcome === "completed");
    const reasons = ss.flatMap((s) => [...s.gates.failedIds, ...s.retryReasons.map((r) => r.split(":")[0]!)]);
    const top = [...new Set(reasons)].map((r) => [r, reasons.filter((x) => x === r).length] as const).sort((a, b) => b[1] - a[1])[0];
    return {
      stage, count: ss.length, firstTimePassRate: done.length ? done.filter((s) => s.firstTimePass).length / done.length : 0,
      avgCostUsd: ss.reduce((n, s) => n + s.costUsd, 0) / ss.length, avgActiveSec: ss.reduce((n, s) => n + s.activeSec, 0) / ss.length,
      ...(top ? { topProblem: { reason: top[0], count: top[1] } } : {}),
    };
  });
}

/** Across runs, per stage: how often it passes first time, what it costs, what breaks it. */
export function formatAll(runs: RunScore[]): string {
  const lines = [
    `${runs.length} runs · total ${money(runs.reduce((n, r) => n + r.costUsd, 0))}`,
    "",
    `${"stage".padEnd(16)} ${"runs".padEnd(5)} ${"1st-pass".padEnd(9)} ${"avg cost".padStart(9)} ${"avg time".padStart(9)}  most common problem`,
  ];
  for (const t of stageStats(runs)) {
    lines.push(`${t.stage.padEnd(16)} ${String(t.count).padEnd(5)} ${`${Math.round(t.firstTimePassRate * 100)}%`.padEnd(9)} ${money(t.avgCostUsd).padStart(9)} ${`${Math.round(t.avgActiveSec)}s`.padStart(9)}  ${t.topProblem ? `${t.topProblem.reason} (${t.topProblem.count}×)` : "-"}`);
  }
  return lines.join("\n");
}

// ---------- outcomes across runs ----------

export interface Outcomes {
  runs: number;
  delivered: number;
  parked: number;
  waiting: number;
  running: number;
  /** all spend, parked and unfinished runs included */
  totalCostUsd: number;
  /** totalCostUsd ÷ delivered; undefined when none delivered */
  costPerDeliveredUsd?: number;
  /** what a delivered run cost on its own, on average */
  avgDeliveredRunCostUsd?: number;
  /** run.created → run.delivered, minutes; includes time waiting for people */
  wallMin: { median?: number; worst?: number };
  /** machine time of delivered runs, minutes */
  activeMinMedian?: number;
  /** cards a human answered per delivered run (question, approval, cap, ...) */
  humanStopsPerDelivered?: number;
  /** delivered runs whose only card was the plan approval (the minimum by design) */
  approvalOnlyShare?: number;
  /** across all runs: finished steps that passed first time */
  firstTimePass: { passed: number; finished: number; rate?: number };
}

const median = (xs: number[]): number | undefined => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1]! + s[m]!) / 2;
};

/** Delivery numbers across runs, from RunScores only. */
export function outcomes(runs: RunScore[]): Outcomes {
  const delivered = runs.filter((r) => r.deliveredAt !== undefined || r.status === "delivered");
  const total = runs.reduce((n, r) => n + r.costUsd, 0);
  const wall = delivered.filter((r) => r.createdAt && r.deliveredAt).map((r) => (Date.parse(r.deliveredAt!) - Date.parse(r.createdAt!)) / 60_000);
  const withCards = delivered.filter((r) => r.humanCards);
  const finished = runs.flatMap((r) => r.steps).filter((s) => s.outcome === "completed");
  const passed = finished.filter((s) => s.firstTimePass).length;
  return {
    runs: runs.length, delivered: delivered.length,
    parked: runs.filter((r) => r.status === "parked").length,
    waiting: runs.filter((r) => r.status === "waiting").length,
    running: runs.filter((r) => r.status === "running").length,
    totalCostUsd: total,
    costPerDeliveredUsd: delivered.length ? total / delivered.length : undefined,
    avgDeliveredRunCostUsd: delivered.length ? delivered.reduce((n, r) => n + r.costUsd, 0) / delivered.length : undefined,
    wallMin: { median: median(wall), worst: wall.length ? Math.max(...wall) : undefined },
    activeMinMedian: median(delivered.map((r) => r.activeMin)),
    humanStopsPerDelivered: withCards.length ? withCards.reduce((n, r) => n + r.humanCards!.length, 0) / withCards.length : undefined,
    approvalOnlyShare: withCards.length ? withCards.filter((r) => r.humanCards!.length === 1 && r.humanCards![0] === "approval").length / withCards.length : undefined,
    firstTimePass: { passed, finished: finished.length, rate: finished.length ? passed / finished.length : undefined },
  };
}

export function formatOutcomes(o: Outcomes): string {
  const opt = (n: number | undefined, f: (n: number) => string) => (n === undefined ? "-" : f(n));
  const min = (n: number) => `${n.toFixed(n < 10 ? 1 : 0)} min`;
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  return [
    "Outcomes",
    `  Delivered             ${o.delivered} of ${o.runs} runs (${o.parked} parked, ${o.waiting} waiting, ${o.running} running)`,
    `  Cost per delivered    ${opt(o.costPerDeliveredUsd, money)} (all spend ${money(o.totalCostUsd)}, parked runs included) · a delivered run alone ${opt(o.avgDeliveredRunCostUsd, money)}`,
    `  Request → branch      wall-clock, incl. waiting for people: median ${opt(o.wallMin.median, min)}, worst ${opt(o.wallMin.worst, min)} · machine time: median ${opt(o.activeMinMedian, min)}`,
    `  Human stops           ${opt(o.humanStopsPerDelivered, (n) => n.toFixed(1))} cards per delivered run · only the plan approval: ${opt(o.approvalOnlyShare, pct)}`,
    `  First-time pass       ${opt(o.firstTimePass.rate, pct)} of ${o.firstTimePass.finished} finished steps`,
  ].join("\n");
}
