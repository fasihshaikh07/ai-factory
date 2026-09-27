// Model routing per step (adapters.md config; stages-aligned §2; WD §4 tiers).
import type { ProjectConfig, StepRoute } from "../config/project.js";
import { hasSecret } from "../config/env.js";
import type { Rung } from "../gates/ladder.js";
import type { Effort } from "../runners/types.js";

const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5";
const HAIKU = "claude-haiku-4-5";

/** Defaults. GPT steps fall back to Opus (noted as single-family) when no OpenAI key exists. */
export const DEFAULT_ROUTES: Record<string, StepRoute> = {
  intake: { runner: "api", model: HAIKU, escalate: [SONNET], effort: "low" },
  ground: { runner: "api", model: OPUS, escalate: [], effort: "high" },
  specify: { runner: "api", model: OPUS, escalate: [], effort: "high" },
  critic: { runner: "api", model: "gpt-5.5", escalate: [], effort: "high" },
  plan: { runner: "api", model: OPUS, escalate: [], effort: "high" },
  "author-tests": { runner: "claude-agent", model: OPUS, escalate: [], effort: "high" },
  implement: { runner: "claude-agent", model: SONNET, escalate: [OPUS], effort: "high" },
  review: { runner: "api", model: "gpt-5.5", escalate: [], effort: "high" },
};

export const THINKING_STEPS = new Set(["intake", "ground", "specify", "critic", "plan", "review", "clarify", "sketches", "clarifier", "merge", "round-trip", "impact"]);
export const CODING_STEPS = new Set(["author-tests", "implement", "conflict-resolve"]);

export function routeFor(project: ProjectConfig, stage: string): StepRoute {
  const r = project.steps[stage] ?? DEFAULT_ROUTES[stage];
  if (!r) throw new Error(`No model route for step ${stage}`);
  return r;
}

/** Model + effort for a ladder rung. */
export function modelFor(project: ProjectConfig, stage: string, rung: number): { model: string; effort: Effort; singleFamilyNote?: string } {
  const r = routeFor(project, stage);
  let model = r.model;
  let note: string | undefined;
  if (/^gpt|^o\d/.test(model) && !hasSecret("OPENAI_API_KEY")) {
    model = OPUS;
    note = `No OpenAI key: ${stage} ran on ${OPUS} (same family as the implementer)`;
  }
  const effort: Effort = rung >= 1 ? "xhigh" : (r.effort ?? "high");
  if (rung >= 2 && r.escalate[0]) model = r.escalate[0];
  return { model, effort, singleFamilyNote: note };
}

/** Rungs this step can use. Other-vendor needs the Codex runner, which isn't built yet. */
export function availableRungs(project: ProjectConfig, stage: string, localOnly: boolean): Set<Rung> {
  const r = routeFor(project, stage);
  const s = new Set<Rung>(["retry", "raise-effort"]);
  if (r.escalate.length) s.add("stronger-model");
  // "other-vendor" is added once the Codex runner exists, and never under localOnly.
  void localOnly;
  return s;
}

/** Start-up checks (adapters.md): thinking steps use api only, coding steps an agent runner, every model has a credential. */
export function checkRoutes(project: ProjectConfig): string[] {
  const problems: string[] = [];
  for (const stage of Object.keys(DEFAULT_ROUTES)) {
    const r = routeFor(project, stage);
    if (THINKING_STEPS.has(stage) && r.runner !== "api") problems.push(`${stage} is a thinking step and must use the api runner`);
    if (CODING_STEPS.has(stage) && r.runner === "api") problems.push(`${stage} is a coding step and needs an agent runner`);
    const { model } = modelFor(project, stage, 0);
    if (model.startsWith("claude-") && !hasSecret("ANTHROPIC_API_KEY")) problems.push(`${stage} needs ANTHROPIC_API_KEY in ~/.factory/.env`);
    if ((r.runner === "codex" || r.runner === "jcode")) problems.push(`${stage}: the ${r.runner} runner isn't built yet`);
  }
  return [...new Set(problems)];
}
