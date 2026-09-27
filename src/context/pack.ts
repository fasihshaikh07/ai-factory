// buildPack (context-builder §2.5): resolve → check trust → redact → wrap → order → count
// → trim (pointer tail, map depth only) → fit or fail → record.
import type { ContextPack, PackClass, SectionSpec, StageName } from "../contracts/index.js";
import { BUDGETS, LOCAL_PACK_CAP } from "../contracts/index.js";
import { hashJson, stableStringify } from "../util/hash.js";
import type { Redactor } from "./secrets.js";
import { estimateTokens } from "./tokens.js";

/** Steps that can write (container A). Untrusted text is a build error here, not config. */
export const WRITING_STAGES: ReadonlySet<StageName> = new Set([
  "author-tests", "implement", "conflict-resolve", "scaffold", "design-mock", "prototype",
]);

export class PackBuildError extends Error {}
export class PackOverBudgetError extends Error {
  constructor(readonly packTokens: number, readonly budget: number, readonly biggest: string) {
    super(`Pack is ${packTokens} tokens, over the ${budget} budget; biggest section: ${biggest}`);
  }
}

export interface ResolvedSection {
  spec: SectionSpec;
  content: string;
  /** for pointers sections */
  pointers?: { path: string; reason: string }[];
  /** for untrusted docs */
  docId?: string;
  source?: string;
  /** for artifacts */
  artifactKind?: string;
  artifactSha?: string;
}

export interface BuildPackInput {
  stage: StageName;
  cls: PackClass;
  budgetTokens?: number;
  model: string;
  local?: boolean;
  recipeVersion: string;
  sections: ResolvedSection[];
  tools: string[];
  redactor: Redactor;
}

const ORDER: SectionSpec["source"][] = ["template", "stackpack", "profile", "rules", "artifact", "doc", "image", "pointers", "feedback", "task", "recap"];

function wrap(s: ResolvedSection, text: string): string {
  switch (s.spec.source) {
    case "doc":
      return `<untrusted_document id="${s.docId ?? s.spec.id}" source="${s.source ?? "unknown"}">\n${text}\n</untrusted_document>`;
    case "artifact":
      return `<artifact id="${s.spec.id}" kind="${s.artifactKind ?? s.spec.ref ?? ""}" sha="${(s.artifactSha ?? "").slice(0, 12)}">\n${text}\n</artifact>`;
    case "pointers":
      return `<pointers>\n${text}\n</pointers>`;
    case "feedback":
      return `<failures>\n${text}\n</failures>`;
    case "recap":
      return `<recap>\n${text}\n</recap>`;
    default:
      return text;
  }
}

function pointersText(ps: { path: string; reason: string }[]): string {
  return ps.map((p) => `- ${p.path}: ${p.reason}`).join("\n");
}

export function buildPack(inp: BuildPackInput): ContextPack {
  // 2. check
  if (WRITING_STAGES.has(inp.stage)) {
    const bad = inp.sections.filter((s) => s.spec.trust === "untrusted" || s.spec.source === "doc" || s.spec.source === "image");
    if (bad.length) throw new PackBuildError(`Stage ${inp.stage} can write, so it can't take untrusted sections: ${bad.map((b) => b.spec.id).join(", ")}`);
  }
  for (const s of inp.sections) {
    if (s.spec.trust === "untrusted" && s.spec.placement === "system") throw new PackBuildError(`Untrusted section ${s.spec.id} can't go in the system prompt`);
  }
  let budget = inp.budgetTokens ?? BUDGETS[inp.cls];
  if (inp.local) budget = Math.min(budget, LOCAL_PACK_CAP);

  // 3–5. redact, wrap, order
  let redactions = 0;
  const prepared = inp.sections.map((s) => {
    const raw = s.spec.source === "pointers" ? pointersText(s.pointers ?? []) : s.content;
    const r = inp.redactor.redact(raw);
    redactions += r.hits.length;
    return { s, text: r.text, trimmed: false, pointers: s.pointers ? [...s.pointers] : undefined };
  }).sort((a, b) => ORDER.indexOf(a.s.spec.source) - ORDER.indexOf(b.s.spec.source));

  const render = () => {
    const sys = prepared.filter((p) => p.s.spec.placement === "system").map((p) => wrap(p.s, p.text));
    const usr = prepared.filter((p) => p.s.spec.placement === "user").map((p) => wrap(p.s, p.text));
    return { system: sys.join("\n\n"), user: usr.join("\n\n") };
  };
  const count = () => {
    const r = render();
    return estimateTokens(r.system + r.user, inp.model);
  };

  // 6–8. count, trim (a) pointer tail (b) map depth, fit
  let tokens = count();
  for (const p of prepared) {
    if (tokens <= budget) break;
    if (p.s.spec.trimmable === "pointers-tail" && p.pointers) {
      while (tokens > budget && p.pointers.length > 1) {
        p.pointers.pop();
        p.text = pointersText(p.pointers);
        p.trimmed = true;
        tokens = count();
      }
    }
  }
  for (const p of prepared) {
    if (tokens <= budget) break;
    if (p.s.spec.trimmable === "map-depth") {
      const lines = p.text.split("\n");
      while (tokens > budget && lines.length > 10) {
        lines.splice(Math.floor(lines.length * 0.75));
        p.text = lines.join("\n") + "\n… (map trimmed; use search)";
        p.trimmed = true;
        tokens = count();
      }
    }
  }
  if (tokens > budget) {
    const biggest = [...prepared].sort((a, b) => b.text.length - a.text.length)[0]?.s.spec.id ?? "?";
    throw new PackOverBudgetError(tokens, budget, biggest);
  }

  const { system, user } = render();
  const pointers = prepared.flatMap((p) => p.pointers ?? []);
  const sections = prepared.map((p) => ({ id: p.s.spec.id, tokens: estimateTokens(p.text, inp.model), trimmed: p.trimmed, trust: p.s.spec.trust }));
  const body = { system, user, images: [] as string[], pointers, tools: inp.tools };
  const manifest = {
    stage: inp.stage, model: inp.model, recipeVersion: inp.recipeVersion, sections,
    packTokens: tokens, budgetTokens: budget, countMethod: "proxy" as const, redactions,
    packSha: hashJson({ ...body, stage: inp.stage, model: inp.model, recipeVersion: inp.recipeVersion }),
  };
  return { ...body, manifest };
}

/** Deterministic serialisation for storing a pack in the ledger. */
export function serialisePack(p: ContextPack): string {
  return stableStringify(p);
}
