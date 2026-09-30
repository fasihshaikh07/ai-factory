// Spec side of the brownfield slice: intake → ground → specify (+lint, critic) → plan → approval card.
import { z } from "zod";
import {
  CurrentBehaviourBody, IntentBody, maxRisk, PlanBody, type Risk, SpecDraft, type Complexity,
} from "../contracts/index.js";
import { checkEvidence } from "../context/tools.js";
import { buildRepoMap } from "../context/repomap.js";
import { failure } from "../gates/engine.js";
import { anchorsResolve, planChecks } from "../gates/predicates.js";
import { isConfigIntegrityPath } from "../gates/protected.js";
import { runGate } from "../gates/engine.js";
import { hashJson } from "../util/hash.js";
import { header, planRejections, readOutput, requireOutput, type StepContext, type StepDef, type StepOutcome } from "./framework.js";
import { acOwners } from "./build.js";
import { clarifications, type ClarifyResult } from "./clarify.js";
import { CriticOut } from "./specpipe.js";
import { describeSources } from "../sources/request.js";
import { S, think, UNTRUSTED_NOTE } from "./think.js";
import { snapshotFor, toolsFor } from "./workspace.js";
import { uiSizeForCard } from "../design/card.js";
import { LANE, lightSpec } from "./lane.js";

type Intent = z.infer<typeof IntentBody>;
type CB = z.infer<typeof CurrentBehaviourBody>;
type Spec = z.infer<typeof SpecDraft>;
type PlanT = z.infer<typeof PlanBody>;

// ---------- risk rules (intake: risk = max(rules, model)) ----------
const RISK_RULES: { tag: string; re: RegExp; risk: Risk }[] = [
  { tag: "auth", re: /\b(auth|login|password|permission|role|token|oauth|sso|jwt)\w*/i, risk: "high" },
  { tag: "payments", re: /\b(payment|billing|invoice|charge|refund|card|stripe)\w*/i, risk: "high" },
  { tag: "pii", re: /\b(ssn|social security|date of birth|dob|address|phone|email|personal data|pii|medical record)\w*/i, risk: "high" },
  { tag: "migration", re: /\b(migration|schema change|alter table|add column|drop column|database change)\w*/i, risk: "high" },
  { tag: "public-api", re: /\b(public api|endpoint|breaking change|contract)\b/i, risk: "medium" },
];
export function ruleRisk(text: string): { risk: Risk; tags: string[] } {
  const hits = RISK_RULES.filter((r) => r.re.test(text));
  return { risk: maxRisk(...hits.map((h) => h.risk)), tags: hits.map((h) => h.tag) };
}

const request = (ctx: Pick<StepContext, "state">) => ctx.state.info.request ?? "";
/** "request.md + Jira ABC-12" (older runs: the file name only) */
const requestFrom = (ctx: Pick<StepContext, "state">) => describeSources(ctx.state.info.sources) || ctx.state.info.requestFile || "";
const jiraSource = (ctx: Pick<StepContext, "state">) => ctx.state.info.sources?.find((s) => s.kind === "jira");

// ---------- intake ----------
export const intakeStep: StepDef = {
  key: "intake", stage: "intake", templateVersion: "1",
  inputs: (s) => ({ request: hashJson(s.info.request ?? "") }),
  async run(ctx) {
    const r = await think(ctx, {
      stage: "intake", route: "intake", cls: "read-small", budgetTokens: 8000, tools: [], schema: IntentBody,
      sections: [
        S.template("tpl", `You are the intake step of a software factory. Read the change request and classify it.
${UNTRUSTED_NOTE}
- Split the request into intent spans: short quotes of the request, each one thing it asks for. IDs I-1, I-2, ...
- changeClass: bugfix | feature | refactor | migration | config.
- risk: low | medium | high. riskTags from: auth, payments, pii, migration, public-api.
- rigor: "light" only for a small, low-risk change; else "full". touchesUi: true if a screen changes.
- source: "cli".`),
        S.untrusted("request", jiraSource(ctx) ? "jira" : "cli", request(ctx)),
        S.task("Classify this request."),
      ],
    });
    if (!r.ok) return r.outcome;
    const rules = ruleRisk(request(ctx));
    const jira = jiraSource(ctx);
    const intent = {
      ...r.output, source: jira ? ("ticket" as const) : ("cli" as const), ...(jira ? { sourceRef: jira.url } : {}),
      risk: maxRisk(r.output.risk, rules.risk), riskTags: [...new Set([...r.output.riskTags, ...rules.tags])],
    };
    const sha = ctx.ledger.putJson({ header: header(ctx.runId, "intent", "intake", "", r.model), ...intent });
    return { kind: "done", outputs: { intent: sha }, data: { changeClass: intent.changeClass, risk: intent.risk } };
  },
};

// ---------- ground ----------
export const groundStep: StepDef = {
  key: "ground", stage: "ground", templateVersion: "1",
  inputs: (s) => (s.steps.get("intake")?.status === "completed" ? { intent: s.steps.get("intake")!.outputs[0], base: s.info.baseCommit } : undefined),
  async run(ctx) {
    const intent = requireOutput<Intent>(ctx.state, ctx.ledger, "intake");
    const snap = snapshotFor(ctx);
    const map = buildRepoMap(snap.root, snap.files, { budgetTokens: 3000 }).map;
    const r = await think(ctx, {
      stage: "ground", route: "ground", cls: "read-large", budgetTokens: 40000, tools: ["read_file", "search", "repo_map"],
      repoTools: toolsFor(ctx), schema: CurrentBehaviourBody, maxTurns: lightSpec(intent) ? LANE.light.groundTurns : LANE.full.groundTurns,
      sections: [
        S.template("tpl", `You are the grounding step. For each intent span, find the code that implements today's behaviour and describe it.
Use search and read_file. Every claim needs at least one anchor: path, lineStart, lineEnd, an exact quote of those lines, and the symbol.
Quotes are checked against the file, so copy them exactly. Anchors that don't match fail the step.
Missing a relevant file is the one mistake no check catches: search for every noun and verb in the request.
If nothing exists yet for a span (new behaviour), list it under notFound with what you searched.`),
        S.profile("repomap", `Repository map (base commit):\n${map}`),
        S.artifact("intent", "intent", intent),
        S.task("Describe the current behaviour relevant to each span, with anchors."),
      ],
    });
    if (!r.ok) return r.outcome;
    const resolved = r.output.claims.flatMap((c) => c.anchors.map((a) => ({ claim: c.id, ...checkEvidence(snap, a) })));
    const cbSha = ctx.ledger.putJson({ header: header(ctx.runId, "current-behaviour", "ground", "", r.model), ...r.output });
    const resSha = ctx.ledger.putJson(resolved);
    const g = await runGate(anchorsResolve, ctx.ledger, ctx.writer, { cb: cbSha, resolved: resSha }, ctx.policy, { step: "ground" });
    if (!g.passed) return { kind: "fail", category: "other", failures: g.failures ?? [], signature: `ground:${g.details.slice(0, 80)}` };
    return { kind: "done", outputs: { cb: cbSha } };
  },
};

// ---------- plan ----------
function complexityOf(plan: PlanT): Complexity {
  const loc = plan.tasks.reduce((n, t) => n + t.plannedLoc, 0);
  if (plan.tasks.length <= 2 && loc <= 150) return "S";
  if (plan.tasks.length <= 5 && loc <= 600) return "M";
  return "L";
}

export const planStep: StepDef = {
  key: "plan", stage: "plan", templateVersion: "1",
  inputs: (s) => (s.steps.get("specify")?.status === "completed" ? { spec: s.steps.get("specify")!.outputs[0], rejections: planRejections(s) } : undefined),
  async run(ctx) {
    const spec = requireOutput<Spec>(ctx.state, ctx.ledger, "specify");
    const cb = requireOutput<CB>(ctx.state, ctx.ledger, "ground");
    const critic = requireOutput<{ findings: unknown[] }>(ctx.state, ctx.ledger, "specify", "critic");
    const snap = snapshotFor(ctx);
    const map = buildRepoMap(snap.root, snap.files, { budgetTokens: 4000, focus: cb.claims.flatMap((c) => c.anchors.map((a) => a.path)) }).map;
    const r = await think(ctx, {
      stage: "plan", route: "plan", cls: "read-large", budgetTokens: 30000, tools: ["read_file", "search", "repo_map"],
      repoTools: toolsFor(ctx), schema: PlanBody, maxTurns: 12,
      sections: [
        S.template("tpl", `You plan the implementation of an approved spec in an existing .NET codebase.
- Give at least 2 options (one marked simplest), choose one, and write a decision record of at most 5 lines (adr).
- Split into tasks TASK-1.. in dependency order. Each task: the requirements it delivers, fileScope (exact repo paths or narrow globs it may change, no overlap between tasks), 1-2 exemplar files to imitate, plannedLoc, approach (short instructions for the implementer).
- Test projects, test files and CI config are not in any file scope: tests are written separately.
- stubs: for every NEW public type/method/endpoint the tests will call, give a compilable stub file (full file content) whose bodies throw NotImplementedException, so tests compile before implementation. Existing APIs need no stubs. Stub paths must be inside a task's fileScope.
- protectedPathsDeclared: list any migration, CI, build-config or package-feed file you must change (a human will see it).
- newDependencies: any NuGet package to add (name, version, registry). Prefer none.`),
        S.profile("repomap", `Repository map:\n${map}`),
        S.artifact("spec", "spec", spec),
        S.artifact("cb", "current-behaviour", cb),
        S.artifact("critic", "critic", critic),
        ...(planRejections(ctx.state).length ? [{ spec: { id: "rejection", source: "feedback" as const, trust: "trusted" as const, placement: "user" as const }, content: `The human reviewer rejected the previous plan. Their reasons (latest last):\n${planRejections(ctx.state).map((x) => `- ${x}`).join("\n")}\nThe plan must address them.` }] : []),
        S.task("Write the plan."),
      ],
    });
    if (!r.ok) return r.outcome;
    const plan = { header: header(ctx.runId, "plan", "plan", "", r.model), ...r.output, complexity: complexityOf(r.output) };
    const fs = [];
    for (const st of plan.stubs) if (!plan.tasks.some((t) => t.fileScope.some((g) => g === st.path || st.path.startsWith(g.replace(/\*.*$/, ""))))) fs.push(failure("plan-stub", `Stub ${st.path} is outside every task's file scope`));
    const planSha = ctx.ledger.putJson(plan);
    const specSha = ctx.state.steps.get("specify")!.outputs[0]!;
    const g = await runGate(planChecks, ctx.ledger, ctx.writer, { plan: planSha, spec: specSha }, ctx.policy, { step: "plan" });
    const all = [...(g.failures ?? []), ...fs];
    if (all.length) return { kind: "fail", category: "other", failures: all, signature: `plan:${all.map((f) => f.check).sort().join(",")}` };
    return { kind: "done", outputs: { plan: planSha }, data: { complexity: plan.complexity, taskCount: plan.tasks.length, tasks: plan.tasks.map((t) => t.id) } };
  },
};

// ---------- approval card ----------
export function plannedFiles(plan: PlanT): string[] {
  return [...new Set(plan.tasks.flatMap((t) => t.fileScope))].sort();
}

export function approvalCard(ctx: StepContext, a: { intent: Intent; spec: Spec; plan: PlanT & { complexity: Complexity }; critic: { findings: z.infer<typeof CriticOut>["findings"]; note?: string }; cb: CB; risk: Risk; clar: ReturnType<typeof clarifications>; open: string[]; /** reworks the spec step made (the light lane allows 1) */ repairs?: number; roundTrip?: { droppedSpans: string[]; inventedCapabilities: string[] }; /** design step: UI size line (absent when the plan touches no UI) */ uiSize?: string }): string {
  const grounded = new Set(a.cb.claims.flatMap((c) => c.anchors.map((x) => x.path)));
  const files = plannedFiles(a.plan);
  const notGrounded = files.filter((f) => !grounded.has(f));
  const protectedTouched = files.filter((f) => isConfigIntegrityPath(f)).concat(a.plan.protectedPathsDeclared);
  const lines = [
    `# Approval: ${a.intent.spans[0]?.text.slice(0, 70) ?? ctx.runId}`,
    ``,
    `Run ${ctx.runId} · risk **${a.risk}** · ${a.intent.changeClass} · size ${a.plan.complexity} · cost so far $${ctx.state.costUsd.toFixed(2)}`,
    ``,
    `## Your request (word for word${requestFrom(ctx) ? `, from ${requestFrom(ctx)}` : ""})`,
    ...(ctx.state.info.sources ?? []).filter((s) => s.kind === "jira").map((s) => `Ticket: ${s.url}`),
    ...request(ctx).split("\n").map((l) => `> ${l}`),
    ``,
    ...(a.clar.answers.length ? [``, `## Your answers`, ...a.clar.answers.map((q) => `- ${q.id} ${q.question} → **${q.answer}**${q.by === "default" || q.by === "default-timeout" ? " (default)" : ""}`)] : []),
    ...(a.clar.assumptions.some((x) => x.risk === "high") ? [``, `## Confirm these assumptions (high risk)`, ...a.clar.assumptions.filter((x) => x.risk === "high").map((x) => `- [ ] ${x.id} ${x.text}`)] : []),
    ...(a.clar.assumptions.some((x) => x.risk !== "high") ? [``, `Other assumptions: ${a.clar.assumptions.filter((x) => x.risk !== "high").map((x) => `${x.id} ${x.text}`).join("; ")}`] : []),
    ``,
    `## Requirements`,
    ...a.spec.requirements.map((r) => `- **${r.id}** (${r.op})${r.stability !== undefined && r.stability < 2 / 3 ? " ⚠ only one draft had this" : ""} ${r.ears}\n${r.acceptance.map((c) => `  - ${c.id} [${c.level}] Given ${c.given}; when ${c.when}; then ${c.then}`).join("\n")}`),
    ``,
    ...(() => {
      const manual = a.spec.requirements.flatMap((r) => r.acceptance.filter((c) => c.level === "manual").map((c) => c.id));
      return manual.length ? [`Checked by a person, not by a test: ${manual.join(", ")} (screens and manual checks aren't automated yet)`, ``] : [];
    })(),
    `Not changing: ${a.spec.outOfScope.join("; ") || "(none listed)"}`,
    ``,
    `## Files the plan will touch (${files.length})`,
    ...files.map((f) => `- ${f}${notGrounded.includes(f) ? "  ← not found by grounding; check it" : ""}${protectedTouched.includes(f) ? "  ← protected file" : ""}`),
    ...(a.plan.newDependencies.length ? [``, `New packages: ${a.plan.newDependencies.map((d) => `${d.name} ${d.version}`).join(", ")}`] : []),
    ...(a.uiSize ? [``, a.uiSize] : []),
    ``,
    `## Plan`,
    `Options: ${a.plan.options.map((o) => `${o.id}${o.id === a.plan.chosen ? " (chosen)" : ""}: ${o.summary}`).join(" | ")}`,
    `Decision: ${a.plan.adr}`,
    ...(() => {
      const owners = acOwners(a.plan, a.spec);
      return a.plan.tasks.map((t) => {
        const acs = [...owners.entries()].filter(([, o]) => o === t.id).map(([ac]) => ac);
        return `- ${t.id} ${t.title} → ${t.reqs.join(", ")}${acs.length ? `; must pass ${acs.join(", ")}` : "; builds towards a later task (no criteria of its own)"}`;
      });
    })(),
    ...(a.plan.stubs.length ? [``, `Stub commit (throws NotImplemented until implemented): ${a.plan.stubs.map((s) => s.path).join(", ")}`] : []),
    ``,
    `## Critic findings (${a.critic.findings.length})`,
    ...a.critic.findings.map((f) => `- [${f.severity}] ${f.reqId ?? ""} ${f.finding}`),
    ...(a.critic.note ? [`_${a.critic.note}_`] : []),
    ...(a.open.length ? [``, `## Still open after ${a.repairs ?? 3} repair${a.repairs === 1 ? "" : "s"}`, ...a.open.map((o) => `- ${o}`)] : []),
    ...(a.roundTrip && !a.roundTrip.droppedSpans.length && !a.roundTrip.inventedCapabilities.length ? [``, `Round trip: the spec restated back matches your request (nothing dropped, nothing added).`] : []),
    ``,
    `## Decide`,
    `  factory approve ${ctx.runId} <hash> --note "your risk note"`,
    `  factory reject  ${ctx.runId} <hash> --reason "why"`,
  ];
  return lines.join("\n");
}

export const approveStep: StepDef = {
  key: "approve", stage: "approve", templateVersion: "1",
  inputs: (s) => (s.steps.get("plan")?.status === "completed" ? { spec: s.steps.get("specify")!.outputs[0], plan: s.steps.get("plan")!.outputs[0], rejections: planRejections(s) } : undefined),
  async run(ctx): Promise<StepOutcome> {
    const planSha = ctx.state.steps.get("plan")!.outputs[0]!;
    const specSha = ctx.state.steps.get("specify")!.outputs[0]!;
    // the rejection round is part of the card's identity: a rejected card never comes back unchanged
    const round = planRejections(ctx.state).length;
    const bundleSha = ctx.ledger.putJson({ spec: specSha, plan: planSha, round });
    const decision = [...ctx.state.decisions].reverse().find((d) => d.artifactSha === bundleSha);
    if (decision?.decision === "approve") {
      const sha = ctx.ledger.putJson({ header: header(ctx.runId, "approval", "approve", ""), auto: false, reason: "human", decision: "approved", by: decision.by, riskNote: String((decision as unknown as { note?: string }).note ?? ""), bundle: bundleSha });
      return { kind: "done", outputs: { approval: sha } };
    }
    // (a rejection changes the spec and plan inputs, so the spec and plan re-run before we get here again;
    //  the second rejection parks the run through the caps check)
    const intent = requireOutput<Intent>(ctx.state, ctx.ledger, "intake");
    const md = approvalCard(ctx, {
      intent, spec: requireOutput<Spec>(ctx.state, ctx.ledger, "specify"),
      plan: requireOutput(ctx.state, ctx.ledger, "plan"), critic: requireOutput(ctx.state, ctx.ledger, "specify", "critic"),
      cb: requireOutput<CB>(ctx.state, ctx.ledger, "ground"), risk: intent.risk,
      clar: clarifications(readOutput<ClarifyResult>(ctx.state, ctx.ledger, "clarify"), readOutput<ClarifyResult>(ctx.state, ctx.ledger, "clarify-2")),
      open: (ctx.state.steps.get("specify")!.data?.openFindings as string[] | undefined) ?? [],
      repairs: ctx.state.steps.get("specify")!.data?.repairs as number | undefined,
      roundTrip: requireOutput<{ roundTrip?: { droppedSpans: string[]; inventedCapabilities: string[] } }>(ctx.state, ctx.ledger, "specify").roundTrip,
      uiSize: uiSizeForCard(snapshotFor(ctx), plannedFiles(requireOutput<PlanT>(ctx.state, ctx.ledger, "plan"))),
    });
    const card = `${md}\n\nCard hash: ${bundleSha.slice(0, 8)}`;
    return { kind: "wait", card: { cardId: `approval-${bundleSha.slice(0, 8)}`, kind: "approval", artifactSha: bundleSha, markdown: card } };
  },
};

export { readOutput };
