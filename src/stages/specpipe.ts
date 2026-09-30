// specify ×3 → merge (+ source check, stability) → lint → critic → round trip, with up to 3
// repairs by one drafter (spec-stage §1, §3.3–3.6, §4). Findings still open after 3 repairs
// go on the approval card.
import { z } from "zod";
import { CriticFinding, CurrentBehaviourBody, IntentBody, SpecDraft } from "../contracts/index.js";
import { checkEvidence } from "../context/tools.js";
import { failure } from "../gates/engine.js";
import { planRejections, requireOutput, readOutput, type StepContext, type StepDef, type StepOutcome } from "./framework.js";
import { clarifications, type ClarifyResult } from "./clarify.js";
import { lintSpec, type LintResult } from "./speclint.js";
import { S, think, UNTRUSTED_NOTE } from "./think.js";
import { snapshotFor, toolsFor } from "./workspace.js";
import { LANE, lightSpec } from "./lane.js";

type Intent = z.infer<typeof IntentBody>;
type CB = z.infer<typeof CurrentBehaviourBody>;
type Spec = z.infer<typeof SpecDraft>;

export const DraftOut = SpecDraft.extend({ suggestions: z.array(z.string()) });
export const MergeOut = z.object({
  spec: SpecDraft,
  alignment: z.array(z.object({ mergedReq: z.string(), from: z.array(z.string()).min(1) })),
  conflicts: z.array(z.string()),
});
export const CriticOut = z.object({ findings: z.array(CriticFinding.extend({ rubric: z.number().int().min(1).max(8) })) });
export const RestateOut = z.object({ sentences: z.array(z.object({ n: z.number().int(), text: z.string() })) });
export const RtAlignOut = z.object({ mapping: z.array(z.object({ n: z.number().int(), spans: z.array(z.string()), answers: z.array(z.string()) })) });

export const MAX_REPAIRS = LANE.full.maxRepairs;

/**
 * The test lab can't test screens yet, so a ui criterion can't get a locked test: it becomes a
 * manual check by a person (no model call), and the approval card says so.
 */
export function downgradeUi<T extends Spec>(spec: T): { spec: T; downgraded: string[] } {
  const downgraded: string[] = [];
  const requirements = spec.requirements.map((r) => ({
    ...r,
    acceptance: r.acceptance.map((a) => {
      if (a.level !== "ui") return a;
      downgraded.push(a.id);
      return { ...a, level: "manual" as const };
    }),
  }));
  return { spec: { ...spec, requirements }, downgraded };
}

// ---------- pure checks ----------

/** Every `from` must name a draft (d1..d3) and a REQ in it; stability = distinct drafts / 3. */
export function checkMerge(m: z.infer<typeof MergeOut>, drafts: Spec[]): { errors: string[]; stability: Record<string, number> } {
  const errors: string[] = [];
  const stability: Record<string, number> = {};
  for (const req of m.spec.requirements) {
    const a = m.alignment.find((x) => x.mergedReq === req.id);
    if (!a) { errors.push(`${req.id} has no source draft`); continue; }
    const ok = a.from.filter((f) => {
      const mm = /^d([123]):(REQ-\d+)$/.exec(f);
      return !!mm && !!drafts[Number(mm[1]) - 1]?.requirements.some((r) => r.id === mm[2]);
    });
    if (ok.length !== a.from.length) errors.push(`${req.id} cites a draft requirement that doesn't exist: ${a.from.filter((f) => !ok.includes(f)).join(", ")}`);
    stability[req.id] = new Set(ok.map((f) => f.slice(0, 2))).size / 3;
  }
  return { errors, stability };
}

/** A dropped span not out of scope fails; a sentence matching no span and no answer is an invention. */
export function roundTripCheck(
  spans: string[], answers: string[], spec: Spec,
  restated: z.infer<typeof RestateOut>["sentences"], mapping: z.infer<typeof RtAlignOut>["mapping"],
): { droppedSpans: string[]; inventedCapabilities: string[] } {
  const covered = new Set(mapping.flatMap((m) => m.spans));
  const outOfScope = spec.outOfScope.join(" ");
  const droppedSpans = spans.filter((s) => !covered.has(s) && !outOfScope.includes(s));
  const known = new Set([...spans, ...answers]);
  const inventedCapabilities = restated
    .filter((r) => { const m = mapping.find((x) => x.n === r.n); return !m || ![...m.spans, ...m.answers].some((x) => known.has(x)); })
    .map((r) => r.text);
  return { droppedSpans, inventedCapabilities };
}

/** Critic blocking is derived by code from severity (gate-engine §2.5). */
export const criticBlocks = (f: { severity: string }) => f.severity === "critical" || f.severity === "high";

// ---------- helpers ----------
const request = (ctx: Pick<StepContext, "state">) => ctx.state.info.request ?? "";

function inputsOf(ctx: StepContext) {
  const intent = requireOutput<Intent>(ctx.state, ctx.ledger, "intake");
  const cb = requireOutput<CB>(ctx.state, ctx.ledger, "ground");
  const c = clarifications(readOutput<ClarifyResult>(ctx.state, ctx.ledger, "clarify"), readOutput<ClarifyResult>(ctx.state, ctx.ledger, "clarify-2"));
  return { intent, cb, ...c };
}

const DRAFT_RULES = `Senior engineer writing a behaviour spec a test author can turn into black-box tests.
Format rules (checked by code):
- Each requirement is one EARS sentence with exactly one "shall": "The <system> shall ...", "When <trigger>, the <system> shall ...", "While <state>, the <system> shall ...", "Where <feature>, the <system> shall ...", "If <condition>, then the <system> shall ...". IDs REQ-1, REQ-2...
- op = ADDED | MODIFIED | REMOVED. MODIFIED and REMOVED copy their anchors exactly from the current-behaviour claims.
- Each requirement has ≥1 acceptance criterion AC-<req>.<n> in Given/When/Then, observable at a public surface: a public class method called directly, an HTTP call, a job run, an outbound call to a named system, a DB row, or a screen. level: unit | api | job | ui | manual.
- Pick the LOWEST level that proves the behaviour: unit when the logic lives in one class (call its public method directly), api for an endpoint, job only when the behaviour exists only in a job run. The factory can't test screens yet: a ui criterion becomes a manual check by a person, so use it only for behaviour that exists only on a screen.
- Change only what the request asks. Other places that might need the same change go in suggestions, not requirements.
- sources: intent span IDs, answer IDs (Q-n) or assumption IDs (ASM-n).
- NFRs need a metric with a number. List out-of-scope items. Every intent span is covered or explicitly out of scope.
- No vague words (fast, robust, user-friendly, appropriate) without a number.
- Don't add capabilities the request didn't ask for; put ideas under suggestions.
- A bugfix has at most 4 requirements.
${UNTRUSTED_NOTE}`;

function draftSections(ctx: StepContext, i: ReturnType<typeof inputsOf>) {
  return [
    S.template("tpl", DRAFT_RULES),
    S.artifact("intent", "intent", i.intent),
    S.artifact("answers", "answers", i.answers),
    S.artifact("assumptions", "assumptions", i.assumptions),
    S.artifact("cb", "current-behaviour", i.cb),
    S.untrusted("request", "cli", request(ctx)),
  ];
}

// ---------- steps ----------

/** Three independent drafts: 2 × Opus + 1 × other family (Sonnet for a low-risk bugfix). The light lane writes one. */
export const draftsStep: StepDef = {
  key: "drafts", stage: "specify", templateVersion: "2",
  inputs: (s) => (s.steps.get("clarify-2")?.status === "completed"
    ? { intent: s.steps.get("intake")!.outputs[0], cb: s.steps.get("ground")!.outputs[0], c1: s.steps.get("clarify")!.outputs[0], c2: s.steps.get("clarify-2")!.outputs[0] } : undefined),
  async run(ctx) {
    const i = inputsOf(ctx);
    const lowBugfix = i.intent.changeClass === "bugfix" && i.intent.risk === "low";
    const light = lightSpec(i.intent);
    const routes = (lowBugfix || light ? ["specify", "specify", "specify"] : ["specify", "specify", "specify-other"]).slice(0, light ? LANE.light.drafts : LANE.full.drafts);
    const models = lowBugfix || light ? routes.map(() => "claude-sonnet-5") : [undefined, undefined, undefined];
    const rs = await Promise.all(routes.map((route, n) => think(ctx, {
      stage: "specify", route, model: models[n], cls: "read-large", budgetTokens: 30000, tools: ["read_file", "search"],
      repoTools: toolsFor(ctx), schema: DraftOut, maxTurns: 8,
      sections: [...draftSections(ctx, i), S.task(routes.length === 1 ? "Write the spec." : `Write the spec (independent draft ${n + 1}).`)],
    })));
    const bad = rs.find((r) => !r.ok);
    if (bad && !bad.ok) return bad.outcome;
    const ok = rs as { ok: true; output: z.infer<typeof DraftOut>; model: string; note?: string }[];
    const sha = ctx.ledger.putJson({ drafts: ok.map((r) => r.output), models: ok.map((r) => r.model), notes: ok.map((r) => r.note).filter(Boolean) });
    return { kind: "done", outputs: { drafts: sha }, data: { models: ok.map((r) => r.model) } };
  },
};

export const mergeStep: StepDef = {
  key: "merge", stage: "merge", templateVersion: "2",
  inputs: (s) => (s.steps.get("drafts")?.status === "completed" ? { drafts: s.steps.get("drafts")!.outputs[0] } : undefined),
  async run(ctx) {
    const { drafts } = requireOutput<{ drafts: z.infer<typeof DraftOut>[] }>(ctx.state, ctx.ledger, "drafts");
    if (drafts.length === 1) {
      // the light lane's single draft: nothing to merge, no model call; stability isn't measured
      const { suggestions: _s, ...spec } = drafts[0]!;
      void _s;
      const alignment = spec.requirements.map((q) => ({ mergedReq: q.id, from: [`d1:${q.id}`] }));
      return { kind: "done", outputs: { merged: ctx.ledger.putJson({ spec, alignment, conflicts: [], singleDraft: true }) }, data: { singleDraft: true, unstable: [] } };
    }
    const r = await think(ctx, {
      stage: "merge", route: "merge", cls: "read-large", budgetTokens: 40000, tools: [], schema: MergeOut, maxTurns: 4,
      sections: [
        S.template("tpl", `Merge three independent spec drafts into one spec (same format rules as the drafts).
Every merged requirement lists in "alignment" which draft requirements it came from, as "d<draft>:<REQ-id>" (e.g. "d1:REQ-2"). Keep a requirement even if only one draft has it. Never write a requirement that is in no draft.
When drafts conflict, keep both readings as separate requirements and add a conflict entry. Renumber merged requirements REQ-1.. and their ACs AC-<req>.<n>.`),
        S.artifact("drafts", "spec-drafts", drafts.map((d, n) => ({ draft: `d${n + 1}`, ...d }))),
        S.task("Merge the drafts."),
      ],
    });
    if (!r.ok) return r.outcome;
    const { errors, stability } = checkMerge(r.output, drafts);
    if (errors.length) return { kind: "fail", category: "other", failures: errors.map((e) => failure("merge-sources", e)), signature: `merge:${errors.length}` };
    const spec = { ...r.output.spec, requirements: r.output.spec.requirements.map((q) => ({ ...q, stability: stability[q.id] })) };
    return { kind: "done", outputs: { merged: ctx.ledger.putJson({ spec, alignment: r.output.alignment, conflicts: r.output.conflicts }) }, data: { unstable: Object.entries(stability).filter(([, v]) => v < 2 / 3).map(([k]) => k) } };
  },
};

interface Checks { lint: LintResult[]; critic: z.infer<typeof CriticOut>["findings"]; roundTrip: { droppedSpans: string[]; inventedCapabilities: string[] }; criticNote?: string }

async function checkSpec(ctx: StepContext, spec: Spec, i: ReturnType<typeof inputsOf>, criticEffort?: "low" | "medium" | "high"): Promise<{ ok: true; checks: Checks } | { ok: false; outcome: StepOutcome }> {
  const snap = snapshotFor(ctx);
  const lint = lintSpec(spec, {
    spans: i.intent.spans.map((s) => s.id), changeClass: i.intent.changeClass,
    anchorOk: (id) => (spec.requirements.find((q) => q.id === id)?.anchors ?? []).every((a) => checkEvidence(snap, a).ok),
  });
  const [critic, restate] = await Promise.all([
    think(ctx, {
      stage: "critic", route: "critic", cls: "read-large", budgetTokens: 30000, tools: [], schema: CriticOut, effort: criticEffort,
      sections: [
        S.template("tpl", `Adversarial reviewer. Find defects in this spec; don't praise; don't rewrite it.
Rubric: 1 conflicts between requirements 2 missing error, empty and permission paths 3 ACs not observable at a public surface 4 scope creep beyond the intent 5 claims about existing behaviour without anchors 6 state transitions and existing data 7 behaviour changes outside the requested scope (blast radius) 8 hardcoded identifiers that should be configuration.
Each finding: rubric number, reqId, severity (critical|high|medium|low), one-sentence evidence in "finding". Empty list if none.`),
        S.artifact("intent", "intent", i.intent),
        S.artifact("cb", "current-behaviour", i.cb),
        S.artifact("spec", "spec", spec),
        S.task("Review the spec."),
      ],
    }),
    think(ctx, {
      stage: "round-trip", route: "restater", cls: "read-small", budgetTokens: 15000, tools: [], schema: RestateOut, maxTurns: 3,
      sections: [
        S.template("tpl", "State, as numbered plain sentences (n = 1, 2, ...), what change this spec asks for. Don't add anything the spec doesn't say. Don't mention IDs."),
        S.artifact("spec", "spec", { requirements: spec.requirements.map((r) => ({ ears: r.ears, acceptance: r.acceptance.map((a) => `Given ${a.given} when ${a.when} then ${a.then}`) })), nfrs: spec.nfrs.map((n) => n.text) }),
        S.task("Restate the change."),
      ],
    }),
  ]);
  if (!critic.ok) return { ok: false, outcome: critic.outcome };
  if (!restate.ok) return { ok: false, outcome: restate.outcome };
  const align = await think(ctx, {
    stage: "round-trip", route: "rt-align", cls: "read-small", budgetTokens: 15000, tools: [], schema: RtAlignOut, maxTurns: 3,
    sections: [
      S.template("tpl", "Map each restated sentence to the original intent spans (I-n) and answers (Q-n) it comes from. A sentence that matches none gets empty lists. Every sentence n must appear once."),
      S.artifact("spans", "intent", i.intent.spans),
      S.artifact("answers", "answers", i.answers),
      S.artifact("sentences", "restated", restate.output.sentences),
      S.task("Map the sentences."),
    ],
  });
  if (!align.ok) return { ok: false, outcome: align.outcome };
  const roundTrip = roundTripCheck(i.intent.spans.map((s) => s.id), [...i.answers.map((a) => a.id), ...i.assumptions.map((a) => a.id)], spec, restate.output.sentences, align.output.mapping);
  return { ok: true, checks: { lint, critic: critic.output.findings, roundTrip, criticNote: critic.note } };
}

function problems(c: Checks): string[] {
  return [
    ...c.lint.filter((l) => l.blocking && !l.passed).map((l) => `[lint ${l.check}] ${l.details}`),
    ...c.critic.filter(criticBlocks).map((f) => `[critic ${f.severity}] ${f.reqId ?? ""} ${f.finding}`),
    ...c.roundTrip.droppedSpans.map((s) => `[round trip] span ${s} isn't covered by the spec`),
    ...c.roundTrip.inventedCapabilities.map((t) => `[round trip] not asked for: ${t}`),
  ];
}

/** Final spec: check, repair (one drafter, merged spec + findings) up to 3 times (once on the light lane). */
export const specifyStep: StepDef = {
  key: "specify", stage: "specify", templateVersion: "3",
  inputs: (s) => (s.steps.get("merge")?.status === "completed" ? { merged: s.steps.get("merge")!.outputs[0], rejections: planRejections(s) } : undefined),
  async run(ctx) {
    const i = inputsOf(ctx);
    const lane = lightSpec(i.intent) ? LANE.light : LANE.full;
    const merged = requireOutput<{ spec: Spec; conflicts: string[] }>(ctx.state, ctx.ledger, "merge");
    // after a rejection, start from the spec the human saw and repair it with their reason first
    const rejections = planRejections(ctx.state);
    let spec = rejections.length ? (readOutput<Spec>(ctx.state, ctx.ledger, "specify") ?? merged.spec) : merged.spec;
    let checks: Checks | undefined;
    let repairs = 0;
    if (rejections.length) {
      ctx.log(`specify: revising for your rejection: ${rejections[rejections.length - 1]}`);
      const r = await think(ctx, {
        stage: "specify", route: "specify", cls: "read-large", budgetTokens: 30000, tools: ["read_file", "search"], repoTools: toolsFor(ctx), schema: DraftOut, maxTurns: 8,
        sections: [
          ...draftSections(ctx, i),
          S.artifact("spec", "spec", spec),
          { spec: { id: "rejection", source: "feedback", trust: "trusted", placement: "user" }, content: `The human reviewer rejected the spec and plan built from this spec. Their reasons (latest last):\n${rejections.map((x) => `- ${x}`).join("\n")}` },
          S.task("Revise this spec so it addresses the reviewer's reasons. Keep requirement IDs stable where the meaning doesn't change. Change nothing the reasons don't need."),
        ],
      });
      if (!r.ok) return r.outcome;
      const { suggestions: _s0, ...draft } = r.output;
      void _s0;
      const stab = Object.fromEntries(spec.requirements.map((q) => [q.id, q.stability]));
      spec = { ...draft, requirements: draft.requirements.map((q) => ({ ...q, stability: stab[q.id] ?? 1 / 3 })) };
    }
    const manualUi = new Set<string>();
    for (;;) {
      const d = downgradeUi(spec);
      spec = d.spec;
      for (const id of d.downgraded) manualUi.add(id);
      const c = await checkSpec(ctx, spec, i, lane.criticEffort);
      if (!c.ok) return c.outcome;
      checks = c.checks;
      const open = problems(checks);
      if (!open.length || repairs >= lane.maxRepairs) break;
      repairs++;
      ctx.log(`specify: repair ${repairs}/${lane.maxRepairs} for ${open.length} findings`);
      const r = await think(ctx, {
        stage: "specify", route: "specify", cls: "read-large", budgetTokens: 30000, tools: ["read_file", "search"], repoTools: toolsFor(ctx), schema: DraftOut, maxTurns: 8,
        sections: [
          ...draftSections(ctx, i),
          S.artifact("spec", "spec", spec),
          S.artifact("findings", "findings", open),
          S.task("Repair this spec so every finding is fixed. Keep requirement IDs stable where the meaning doesn't change. Change nothing the findings don't need."),
        ],
      });
      if (!r.ok) return r.outcome;
      const stab = Object.fromEntries(spec.requirements.map((q) => [q.id, q.stability]));
      const { suggestions: _s, ...draft } = r.output;
      void _s;
      spec = { ...draft, requirements: draft.requirements.map((q) => ({ ...q, stability: stab[q.id] ?? 1 / 3 })) };
    }
    const hardLint = checks!.lint.filter((l) => l.blocking && !l.passed);
    if (hardLint.length) {
      // a spec that still fails format checks can't go to a human for approval
      return { kind: "fail", category: "other", failures: hardLint.map((l) => failure(`spec-lint ${l.check}`, l.details)), signature: `lint:${hardLint.map((l) => l.check).join(",")}` };
    }
    const specSha = ctx.ledger.putJson({ ...spec, lint: checks!.lint.map(({ check, passed, details }) => ({ check, passed, details })), critic: checks!.critic, roundTrip: checks!.roundTrip });
    const criticSha = ctx.ledger.putJson({ findings: checks!.critic, note: checks!.criticNote });
    return {
      kind: "done", outputs: { spec: specSha, critic: criticSha },
      data: { repairs, openFindings: problems(checks!), conflicts: merged.conflicts, manualUi: [...manualUi], lane: lane === LANE.light ? "light" : "full" },
    };
  },
};
