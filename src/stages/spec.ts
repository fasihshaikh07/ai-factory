// Spec side of the brownfield slice: intake → ground → specify (+lint, critic) → plan → approval card.
import { z } from "zod";
import {
  CriticFinding, CurrentBehaviourBody, IntentBody, maxRisk, PlanBody, type Risk, SpecDraft, type Complexity,
} from "../contracts/index.js";
import { checkEvidence } from "../context/tools.js";
import { buildRepoMap } from "../context/repomap.js";
import { failure } from "../gates/engine.js";
import { anchorsResolve, planChecks } from "../gates/predicates.js";
import { isConfigIntegrityPath } from "../gates/protected.js";
import { runGate } from "../gates/engine.js";
import { hashJson } from "../util/hash.js";
import { header, readOutput, requireOutput, type StepContext, type StepDef, type StepOutcome } from "./framework.js";
import { lintSpec } from "./speclint.js";
import { S, think, UNTRUSTED_NOTE } from "./think.js";
import { snapshotFor, toolsFor } from "./workspace.js";

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
        S.untrusted("request", "cli", request(ctx)),
        S.task("Classify this request."),
      ],
    });
    if (!r.ok) return r.outcome;
    const rules = ruleRisk(request(ctx));
    const intent = { ...r.output, source: "cli" as const, risk: maxRisk(r.output.risk, rules.risk), riskTags: [...new Set([...r.output.riskTags, ...rules.tags])] };
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
      repoTools: toolsFor(ctx), schema: CurrentBehaviourBody, maxTurns: 12,
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

// ---------- specify (+ lint + critic) ----------
export const specifyStep: StepDef = {
  key: "specify", stage: "specify", templateVersion: "1",
  inputs: (s) => (s.steps.get("ground")?.status === "completed" ? { intent: s.steps.get("intake")!.outputs[0], cb: s.steps.get("ground")!.outputs[0] } : undefined),
  async run(ctx) {
    const intent = requireOutput<Intent>(ctx.state, ctx.ledger, "intake");
    const cb = requireOutput<CB>(ctx.state, ctx.ledger, "ground");
    const snap = snapshotFor(ctx);
    const r = await think(ctx, {
      stage: "specify", route: "specify", cls: "read-large", budgetTokens: 30000, tools: ["read_file", "search"],
      repoTools: toolsFor(ctx), schema: SpecDraft, maxTurns: 8,
      sections: [
        S.template("tpl", `You write the specification for a change to an existing system.
Requirements use EARS: "The <system> shall <response>", "When <trigger>, the <system> shall <response>", "While <state>, ...", "If <condition>, then the <system> shall <response>". Exactly one "shall" each. IDs REQ-1, REQ-2...
op: ADDED (new), MODIFIED or REMOVED (existing behaviour; these need anchors copied exactly from the current-behaviour claims).
Each requirement lists its source intent span IDs and has acceptance criteria AC-<req>.<n> in Given/When/Then that a black-box test can check at a public surface (HTTP response, database row, outbound call, screen). level: api | job | ui | manual.
Include error, empty and permission paths. No vague words (fast, robust, appropriate) without numbers.
Don't invent features the request doesn't ask for. List what isn't changing under outOfScope. assumptions: IDs only, may be empty.
Keep it small: a bugfix has at most 4 requirements.`),
        S.artifact("intent", "intent", intent),
        S.artifact("cb", "current-behaviour", cb),
        S.task("Write the spec."),
        S.recap(["EARS with one shall", "every span covered or out of scope", "ACs observable from outside", "anchors copied exactly for MODIFIED/REMOVED"]),
      ],
    });
    if (!r.ok) return r.outcome;
    const spec = r.output;
    const lint = lintSpec(spec, {
      spans: intent.spans.map((s) => s.id), changeClass: intent.changeClass,
      anchorOk: (id) => (spec.requirements.find((q) => q.id === id)?.anchors ?? []).every((a) => checkEvidence(snap, a).ok),
    });
    const blocking = lint.filter((l) => l.blocking && !l.passed);
    if (blocking.length) {
      return { kind: "fail", category: "other", failures: blocking.map((l) => failure(`spec-lint ${l.check}`, l.details)), signature: `lint:${blocking.map((b) => b.check).join(",")}` };
    }
    const specSha = ctx.ledger.putJson({ header: header(ctx.runId, "spec", "specify", "", r.model), ...spec, lint: lint.map(({ check, passed, details }) => ({ check, passed, details })), critic: [], roundTrip: { droppedSpans: [], inventedCapabilities: [] } });
    return { kind: "done", outputs: { spec: specSha }, data: { lintAdvisories: lint.filter((l) => !l.passed).map((l) => l.check) } };
  },
};

const CriticOut = z.object({ findings: z.array(CriticFinding.extend({ rubric: z.number().int().min(1).max(8) })) });

export const criticStep: StepDef = {
  key: "critic", stage: "critic", templateVersion: "1",
  inputs: (s) => (s.steps.get("specify")?.status === "completed" ? { spec: s.steps.get("specify")!.outputs[0] } : undefined),
  async run(ctx) {
    const intent = requireOutput<Intent>(ctx.state, ctx.ledger, "intake");
    const cb = requireOutput<CB>(ctx.state, ctx.ledger, "ground");
    const spec = requireOutput<Spec>(ctx.state, ctx.ledger, "specify");
    const r = await think(ctx, {
      stage: "critic", route: "critic", cls: "read-large", budgetTokens: 30000, tools: [], schema: CriticOut,
      sections: [
        S.template("tpl", `Adversarial reviewer. Find defects in this spec; don't praise; don't rewrite it.
Rubric: 1 conflicts between requirements 2 missing error, empty and permission paths 3 ACs not observable at a public surface 4 scope creep beyond the intent 5 claims about existing behaviour without anchors 6 state transitions and existing data 7 behaviour changes outside the requested scope (blast radius) 8 hardcoded identifiers that should be configuration.
Each finding: rubric number, reqId, severity (critical|high|medium|low), one-sentence evidence in "finding". Empty list if none.`),
        S.artifact("intent", "intent", intent),
        S.artifact("cb", "current-behaviour", cb),
        S.artifact("spec", "spec", spec),
        S.task("Review the spec."),
      ],
    });
    if (!r.ok) return r.outcome;
    const sha = ctx.ledger.putJson({ findings: r.output.findings, note: r.note });
    return { kind: "done", outputs: { critic: sha } };
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
  inputs: (s) => (s.steps.get("critic")?.status === "completed" ? { spec: s.steps.get("specify")!.outputs[0], critic: s.steps.get("critic")!.outputs[0] } : undefined),
  async run(ctx) {
    const spec = requireOutput<Spec>(ctx.state, ctx.ledger, "specify");
    const cb = requireOutput<CB>(ctx.state, ctx.ledger, "ground");
    const critic = requireOutput<{ findings: unknown[] }>(ctx.state, ctx.ledger, "critic");
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

export function approvalCard(ctx: StepContext, a: { intent: Intent; spec: Spec; plan: PlanT & { complexity: Complexity }; critic: { findings: z.infer<typeof CriticOut>["findings"]; note?: string }; cb: CB; risk: Risk }): string {
  const grounded = new Set(a.cb.claims.flatMap((c) => c.anchors.map((x) => x.path)));
  const files = plannedFiles(a.plan);
  const notGrounded = files.filter((f) => !grounded.has(f));
  const protectedTouched = files.filter((f) => isConfigIntegrityPath(f)).concat(a.plan.protectedPathsDeclared);
  const lines = [
    `# Approval: ${a.intent.spans[0]?.text.slice(0, 70) ?? ctx.runId}`,
    ``,
    `Run ${ctx.runId} · risk **${a.risk}** · ${a.intent.changeClass} · size ${a.plan.complexity} · cost so far $${ctx.state.costUsd.toFixed(2)}`,
    ``,
    `## Your request (word for word)`,
    ...request(ctx).split("\n").map((l) => `> ${l}`),
    ``,
    `## Requirements`,
    ...a.spec.requirements.map((r) => `- **${r.id}** (${r.op}) ${r.ears}\n${r.acceptance.map((c) => `  - ${c.id} [${c.level}] Given ${c.given}; when ${c.when}; then ${c.then}`).join("\n")}`),
    ``,
    `Not changing: ${a.spec.outOfScope.join("; ") || "(none listed)"}`,
    ``,
    `## Files the plan will touch (${files.length})`,
    ...files.map((f) => `- ${f}${notGrounded.includes(f) ? "  ← not found by grounding; check it" : ""}${protectedTouched.includes(f) ? "  ← protected file" : ""}`),
    ...(a.plan.newDependencies.length ? [``, `New packages: ${a.plan.newDependencies.map((d) => `${d.name} ${d.version}`).join(", ")}`] : []),
    ``,
    `## Plan`,
    `Options: ${a.plan.options.map((o) => `${o.id}${o.id === a.plan.chosen ? " (chosen)" : ""}: ${o.summary}`).join(" | ")}`,
    `Decision: ${a.plan.adr}`,
    ...a.plan.tasks.map((t) => `- ${t.id} ${t.title} → ${t.reqs.join(", ")}`),
    ...(a.plan.stubs.length ? [``, `Stub commit (throws NotImplemented until implemented): ${a.plan.stubs.map((s) => s.path).join(", ")}`] : []),
    ``,
    `## Critic findings (${a.critic.findings.length})`,
    ...a.critic.findings.map((f) => `- [${f.severity}] ${f.reqId ?? ""} ${f.finding}`),
    ...(a.critic.note ? [`_${a.critic.note}_`] : []),
    ``,
    `## Decide`,
    `  factory approve ${ctx.runId} <hash> --note "your risk note"`,
    `  factory reject  ${ctx.runId} <hash> --reason "why"`,
  ];
  return lines.join("\n");
}

export const approveStep: StepDef = {
  key: "approve", stage: "approve", templateVersion: "1",
  inputs: (s) => (s.steps.get("plan")?.status === "completed" ? { spec: s.steps.get("specify")!.outputs[0], plan: s.steps.get("plan")!.outputs[0] } : undefined),
  async run(ctx): Promise<StepOutcome> {
    const planSha = ctx.state.steps.get("plan")!.outputs[0]!;
    const specSha = ctx.state.steps.get("specify")!.outputs[0]!;
    const bundleSha = ctx.ledger.putJson({ spec: specSha, plan: planSha });
    const decision = [...ctx.state.decisions].reverse().find((d) => d.artifactSha === bundleSha);
    if (decision?.decision === "approve") {
      const sha = ctx.ledger.putJson({ header: header(ctx.runId, "approval", "approve", ""), auto: false, reason: "human", decision: "approved", by: decision.by, riskNote: String((decision as unknown as { note?: string }).note ?? ""), bundle: bundleSha });
      return { kind: "done", outputs: { approval: sha } };
    }
    if (decision?.decision === "reject") {
      return { kind: "park", reason: `Plan rejected by ${decision.by}: ${String((decision as { reason?: unknown }).reason ?? "")}. Change the request with \`factory steer\` or start a new run.` };
    }
    const intent = requireOutput<Intent>(ctx.state, ctx.ledger, "intake");
    const md = approvalCard(ctx, {
      intent, spec: requireOutput<Spec>(ctx.state, ctx.ledger, "specify"),
      plan: requireOutput(ctx.state, ctx.ledger, "plan"), critic: requireOutput(ctx.state, ctx.ledger, "critic"),
      cb: requireOutput<CB>(ctx.state, ctx.ledger, "ground"), risk: intent.risk,
    });
    const card = `${md}\n\nCard hash: ${bundleSha.slice(0, 8)}`;
    return { kind: "wait", card: { cardId: `approval-${bundleSha.slice(0, 8)}`, kind: "approval", artifactSha: bundleSha, markdown: card } };
  },
};

export { readOutput };
