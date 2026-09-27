// Clarify (spec-stage §2, §3.1–3.2): 3 independent sketches → differences (aligned by a cheap
// model, checked by code) → clarifier writes multiple-choice questions → code scores
// impact × uncertainty, asks ≤5 (then ≤3 more, 8 total), the rest become assumptions.
import { z } from "zod";
import { CurrentBehaviourBody, IntentBody, type Risk } from "../contracts/index.js";
import { failure } from "../gates/engine.js";
import { hashJson } from "../util/hash.js";
import { requireOutput, type StepContext, type StepDef, type StepOutcome } from "./framework.js";
import { S, think, UNTRUSTED_NOTE } from "./think.js";

type Intent = z.infer<typeof IntentBody>;
type CB = z.infer<typeof CurrentBehaviourBody>;

// ---------- schemas ----------
export const SketchOut = z.object({
  spans: z.array(z.object({
    id: z.string(),
    behaviours: z.array(z.object({ text: z.string(), kind: z.enum(["happy", "error", "permission", "data"]) })),
    readingChosen: z.string().optional(),
  })),
});
export type Sketch = z.infer<typeof SketchOut>;

export const AlignOut = z.object({
  differences: z.array(z.object({
    id: z.string(), span: z.string(), topic: z.string(),
    readings: z.array(z.object({ sketch: z.number().int().min(1).max(3), behaviour: z.number().int().min(0), summary: z.string() })).min(2),
  })),
});
export type Difference = z.infer<typeof AlignOut>["differences"][number];

export const ClarifierOut = z.object({
  questions: z.array(z.object({
    id: z.string(),
    category: z.enum(["scope", "data-model", "roles", "existing-data", "errors", "external", "identifiers", "blast-radius", "terminology"]),
    text: z.string(),
    options: z.array(z.string()).min(2).max(4),
    recommended: z.string(),
    reason: z.string(),
    spans: z.array(z.string()),
    impact: z.number().int().min(1).max(3),
    impactReason: z.string(),
    difference: z.string().optional(),
  })),
  conflicts: z.array(z.string()),
});
export type ClarifierQuestion = z.infer<typeof ClarifierOut>["questions"][number];

export interface ScoredQuestion extends ClarifierQuestion { uncertainty: 1 | 2 | 3; score: number }
export interface Assumption { id: string; text: string; risk: Risk; fromSpan: string[]; fromQuestion: string }
export interface ClarifyResult {
  round: number;
  asked: ScoredQuestion[];
  assumptions: Assumption[];
  differences: Difference[];
  conflicts: string[];
  answers?: Record<string, string>;
  answeredBy?: string;
}

export const ASK_THRESHOLD = 4;
export const ROUND1_CAP = 5;
export const ROUND2_CAP = 3;
export const TOTAL_CAP = 8;
const GOAL_FIRST = ["scope", "blast-radius", "roles", "data-model", "existing-data", "errors", "external", "identifiers", "terminology"];

/** Keep only differences whose cited behaviours exist in ≥2 different sketches. */
export function verifyDifferences(diffs: Difference[], sketches: Sketch[]): Difference[] {
  return diffs.filter((d) => {
    const ok = d.readings.filter((r) => {
      const span = sketches[r.sketch - 1]?.spans.find((s) => s.id === d.span);
      return !!span && r.behaviour < span.behaviours.length;
    });
    return new Set(ok.map((r) => r.sketch)).size >= 2 && ok.length === d.readings.length;
  });
}

/**
 * Uncertainty (code): 3 = backed by a verified sketch difference; 2 = a span grounding found
 * nothing for, or with no anchored claim; 1 = only the clarifier flagged it.
 */
export function scoreQuestions(qs: ClarifierQuestion[], diffs: Difference[], cb: CB): ScoredQuestion[] {
  const diffIds = new Set(diffs.map((d) => d.id));
  const diffSpans = new Set(diffs.map((d) => d.span));
  const anchored = new Set(cb.claims.flatMap((c) => c.spans));
  const notFound = new Set(cb.notFound.map((n) => n.span));
  return qs.map((q) => {
    const u: 1 | 2 | 3 = (q.difference && diffIds.has(q.difference)) || q.spans.some((s) => diffSpans.has(s)) ? 3
      : q.spans.some((s) => notFound.has(s) || !anchored.has(s)) ? 2 : 1;
    return { ...q, uncertainty: u, score: q.impact * u };
  });
}

/** Ask score ≥ 4 up to the cap, goal/scope first; everything else becomes an assumption. */
export function selectQuestions(scored: ScoredQuestion[], cap: number, idStart = 1): { asked: ScoredQuestion[]; assumptions: Assumption[] } {
  const eligible = scored.filter((q) => q.score >= ASK_THRESHOLD)
    .sort((a, b) => b.score - a.score || GOAL_FIRST.indexOf(a.category) - GOAL_FIRST.indexOf(b.category));
  const asked = eligible.slice(0, cap).map((q, i) => ({ ...q, id: `Q-${idStart + i}` }));
  const askedSet = new Set(eligible.slice(0, cap));
  const assumptions = scored.filter((q) => !askedSet.has(q)).map((q, i) => ({
    id: `ASM-${idStart + i}`,
    text: `${q.text} → assumed: ${q.recommended}`,
    risk: (q.impact === 3 ? "high" : "low") as Risk,
    fromSpan: q.spans,
    fromQuestion: q.id,
  }));
  return { asked, assumptions };
}

export function questionCard(runId: string, round: number, asked: ScoredQuestion[], assumptions: Assumption[], cardHash: string, request: string): string {
  return [
    `# Questions before the spec (round ${round})`,
    ``,
    `Run ${runId}. Your request:`,
    ...request.split("\n").map((l) => `> ${l}`),
    ``,
    ...asked.flatMap((q) => [
      `**${q.id}** ${q.text}`,
      ...q.options.map((o, i) => `  ${String.fromCharCode(65 + i)}. ${o}${o === q.recommended ? "   ← recommended: " + q.reason : ""}`),
      `  (why it matters: ${q.impactReason})`,
      ``,
    ]),
    ...(assumptions.length ? [`Assumed unless you say otherwise:`, ...assumptions.map((a) => `- ${a.id}${a.risk === "high" ? " (high risk, confirm on the approval card)" : ""}: ${a.text}`), ``] : []),
    `Answer with letters or your own words:`,
    `  factory answer ${runId} ${cardHash.slice(0, 8)} ${asked.map((q) => `${q.id}=A`).join(" ")}`,
    `  (use quotes for words: ${asked[0]?.id ?? "Q-1"}="only for guest checkouts")`,
  ].join("\n");
}

/** Turn "A"/"b"/free text into the option text. */
export function resolveAnswer(q: ScoredQuestion, raw: string): string {
  const t = raw.trim();
  if (/^[A-Da-d]$/.test(t)) {
    const o = q.options[t.toUpperCase().charCodeAt(0) - 65];
    if (o) return o;
  }
  return t;
}

// ---------- steps ----------
const request = (ctx: Pick<StepContext, "state">) => ctx.state.info.request ?? "";

async function runSketches(ctx: StepContext, intent: Intent, cb: CB): Promise<{ ok: true; sketches: Sketch[]; diffs: Difference[] } | { ok: false; outcome: StepOutcome }> {
  const one = (n: number) => think(ctx, {
    stage: "sketches", route: "sketches", cls: "read-small", budgetTokens: 12000, tools: [], schema: SketchOut, maxTurns: 3,
    sections: [
      S.template("tpl", `You are one of several engineers independently reading a change request.
For each intent span, list the concrete, observable behaviours you would make the system do (inputs → outputs, data written, who can do what). Include the unhappy paths you think are implied.
Don't ask questions. Don't write a spec. If a span can be read two ways, pick one and say which reading you chose (readingChosen). Only behaviours; no implementation.
${UNTRUSTED_NOTE}`),
      S.artifact("intent", "intent", intent.spans),
      S.artifact("cb", "current-behaviour", cb.claims.map((c) => ({ id: c.id, text: c.text, spans: c.spans }))),
      S.untrusted("request", "cli", request(ctx)),
      S.task(`Reading #${n}: list the behaviours per span.`),
    ],
  });
  const rs = await Promise.all([one(1), one(2), one(3)]);
  const bad = rs.find((r) => !r.ok);
  if (bad && !bad.ok) return { ok: false, outcome: bad.outcome };
  const sketches = rs.map((r) => (r as { output: Sketch }).output);
  const al = await think(ctx, {
    stage: "sketches", route: "sketch-align", cls: "read-small", budgetTokens: 15000, tools: [], schema: AlignOut, maxTurns: 3,
    sections: [
      S.template("tpl", `Three engineers independently listed behaviours for the same request. Find where they DISAGREE about what the system should do (not wording differences).
For each disagreement: id D-1.., the span, a short topic, and the readings: which sketch (1-3), which behaviour index (0-based) in that span, and a one-line summary. Cite at least two different sketches. Empty list if they agree.`),
      S.artifact("sketches", "sketches", sketches.map((s, i) => ({ sketch: i + 1, spans: s.spans.map((sp) => ({ id: sp.id, readingChosen: sp.readingChosen, behaviours: sp.behaviours.map((b, j) => `${j}: ${b.text}`) })) }))),
      S.task("List the disagreements."),
    ],
  });
  if (!al.ok) return { ok: false, outcome: al.outcome };
  return { ok: true, sketches, diffs: verifyDifferences(al.output.differences, sketches) };
}

async function runClarifier(ctx: StepContext, intent: Intent, cb: CB, sketches: Sketch[], diffs: Difference[], prior?: ClarifyResult) {
  return think(ctx, {
    stage: "clarifier", route: "clarifier", cls: "read-large", budgetTokens: 20000, tools: [], schema: ClarifierOut, maxTurns: 4,
    sections: [
      S.template("tpl", `Requirements analyst. Your only job is finding what is unclear or missing. You don't write the spec.
Check: scope, data model, user roles and permissions, existing data and state changes, error and failure handling, external systems, hardcoded identifiers (constant or configuration?), behaviour outside the named scope, terminology.
For each issue: a question with 2-4 options, one "recommended" (copy the option text exactly) with a one-line reason, the intent spans it affects, impact 1-3 with a reason (3 = changes data or who sees what: writes, orders, permissions, money; 2 = a visible flow; 1 = wording). If it comes from a listed disagreement, give its id in "difference".
Never ask what the code or the readings already answer.${prior ? "\nThe human already answered some questions. Only ask NEW questions that their answers opened up; don't repeat or rephrase answered ones." : ""}
${UNTRUSTED_NOTE}`),
      S.artifact("intent", "intent", intent.spans),
      S.artifact("cb", "current-behaviour", cb),
      S.artifact("sketches", "sketches", sketches),
      S.artifact("differences", "differences", diffs),
      ...(prior ? [S.artifact("answers", "answers", prior.asked.map((q) => ({ id: q.id, question: q.text, answer: prior.answers?.[q.id] })))] : []),
      S.untrusted("request", "cli", request(ctx)),
      S.task("List the questions."),
    ],
  });
}

function cardOrDone(ctx: StepContext, key: string, result: ClarifyResult, pending: { cacheKey: string; sha: string }): StepOutcome {
  if (!result.asked.length) return { kind: "done", outputs: { clarify: ctx.ledger.putJson(result) }, data: { asked: 0, assumptions: result.assumptions.length } };
  const cardSha = ctx.ledger.putJson({ key, asked: result.asked, assumptions: result.assumptions });
  const decision = [...ctx.state.decisions].reverse().find((d) => d.artifactSha === cardSha);
  if (decision) {
    const raw = ((decision as unknown as { answers?: Record<string, string> }).answers ?? {});
    const answers = Object.fromEntries(result.asked.map((q) => [q.id, resolveAnswer(q, raw[q.id] ?? q.recommended)]));
    const done: ClarifyResult = { ...result, answers, answeredBy: decision.by };
    return { kind: "done", outputs: { clarify: ctx.ledger.putJson(done) }, data: { asked: result.asked.length, assumptions: result.assumptions.length } };
  }
  const lowRisk = result.asked.every((q) => q.impact < 3);
  return {
    kind: "wait",
    card: {
      cardId: `questions-${result.round}-${cardSha.slice(0, 8)}`, kind: "question", artifactSha: cardSha,
      markdown: questionCard(ctx.runId, result.round, result.asked, result.assumptions, cardSha, request(ctx)) + `\n\nCard hash: ${cardSha.slice(0, 8)}${lowRisk ? "\nLow-risk questions: the recommended answers are used after 24 hours." : ""}`,
      extra: { cacheKey: pending.cacheKey, pendingSha: pending.sha },
      ...(lowRisk ? { deadline: new Date(Date.now() + 24 * 3600_000).toISOString(), defaultDecision: { answers: Object.fromEntries(result.asked.map((q) => [q.id, q.recommended])) } } : {}),
    },
  };
}

/**
 * Round 1. The model work is cached as a named output of the step's first attempt, so a
 * resumed step (after the human answers) doesn't pay for the sketches again.
 */
export const clarifyStep: StepDef = {
  key: "clarify", stage: "clarify", templateVersion: "1",
  inputs: (s) => (s.steps.get("ground")?.status === "completed" ? { intent: s.steps.get("intake")!.outputs[0], cb: s.steps.get("ground")!.outputs[0] } : undefined),
  async run(ctx) {
    const intent = requireOutput<Intent>(ctx.state, ctx.ledger, "intake");
    const cb = requireOutput<CB>(ctx.state, ctx.ledger, "ground");
    const cacheKey = hashJson({ step: "clarify", intent: ctx.state.steps.get("intake")!.outputs[0], cb: ctx.state.steps.get("ground")!.outputs[0] });
    let pending = pendingFor(ctx, cacheKey);
    if (!pending) {
      const sk = await runSketches(ctx, intent, cb);
      if (!sk.ok) return sk.outcome;
      const cl = await runClarifier(ctx, intent, cb, sk.sketches, sk.diffs);
      if (!cl.ok) return cl.outcome;
      const scored = scoreQuestions(cl.output.questions, sk.diffs, cb);
      const { asked, assumptions } = selectQuestions(scored, ROUND1_CAP);
      pending = { round: 1, asked, assumptions, differences: sk.diffs, conflicts: cl.output.conflicts, sketches: sk.sketches };
    }
    const { sketches: _s, ...result } = pending;
    void _s;
    return cardOrDone(ctx, "clarify", result, { cacheKey, sha: ctx.ledger.putJson(pending) });
  },
};

/** Round 2: only if round 1 asked; ≤3 new questions, 8 in total. */
export const clarify2Step: StepDef = {
  key: "clarify-2", stage: "clarify", templateVersion: "1",
  inputs: (s) => (s.steps.get("clarify")?.status === "completed" ? { r1: s.steps.get("clarify")!.outputs[0] } : undefined),
  async run(ctx) {
    const r1 = requireOutput<ClarifyResult>(ctx.state, ctx.ledger, "clarify");
    if (!r1.asked.length) return { kind: "done", outputs: { clarify: ctx.ledger.putJson({ round: 2, asked: [], assumptions: [], differences: [], conflicts: [] }) }, data: { skipped: true } };
    const cacheKey = hashJson({ step: "clarify-2", r1: ctx.state.steps.get("clarify")!.outputs[0] });
    let pending = pendingFor(ctx, cacheKey);
    if (!pending) {
      const intent = requireOutput<Intent>(ctx.state, ctx.ledger, "intake");
      const cb = requireOutput<CB>(ctx.state, ctx.ledger, "ground");
      const cl = await runClarifier(ctx, intent, cb, [], r1.differences, r1);
      if (!cl.ok) return cl.outcome;
      const already = new Set(r1.asked.map((q) => q.text.toLowerCase()));
      const fresh = scoreQuestions(cl.output.questions.filter((q) => !already.has(q.text.toLowerCase())), [], cb)
        // answers that opened a new gap count as disagreement-backed
        .map((q) => ({ ...q, uncertainty: Math.max(q.uncertainty, 2) as 2 | 3, score: q.impact * Math.max(q.uncertainty, 2) }));
      const cap = Math.min(ROUND2_CAP, TOTAL_CAP - r1.asked.length);
      const { asked, assumptions } = selectQuestions(fresh, cap, r1.asked.length + 1);
      pending = { round: 2, asked, assumptions: assumptions.map((a, i) => ({ ...a, id: `ASM-${r1.assumptions.length + i + 1}` })), differences: [], conflicts: cl.output.conflicts };
    }
    return cardOrDone(ctx, "clarify-2", pending, { cacheKey, sha: ctx.ledger.putJson(pending) });
  },
};

// Work done before a question card is cached on the card's human.requested event, so the
// attempt after the human answers doesn't pay for the sketches and clarifier again.
type Pending = ClarifyResult & { sketches?: Sketch[] };
function pendingFor(ctx: StepContext, cacheKey: string): Pending | undefined {
  const ev = [...ctx.ledger.events()].reverse().find((e) => e.type === "human.requested" && (e.data as { cacheKey?: string })?.cacheKey === cacheKey);
  const sha = (ev?.data as { pendingSha?: string } | undefined)?.pendingSha;
  return sha ? ctx.ledger.getJson<Pending>(sha) : undefined;
}

/** All answers + assumptions from both rounds, for the drafters and the card. */
export function clarifications(r1?: ClarifyResult, r2?: ClarifyResult) {
  const rounds = [r1, r2].filter(Boolean) as ClarifyResult[];
  return {
    answers: rounds.flatMap((r) => r.asked.map((q) => ({ id: q.id, question: q.text, answer: r.answers?.[q.id] ?? q.recommended, by: r.answeredBy ?? "default" }))),
    assumptions: rounds.flatMap((r) => r.assumptions),
    conflicts: rounds.flatMap((r) => r.conflicts),
  };
}

export { failure };
