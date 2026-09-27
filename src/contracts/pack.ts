// Context packs and recipes (contracts §9, context-builder §2).
import { z } from "zod";
import { Sha, StageName } from "./common.js";

export const PackClass = z.enum(["read-small", "read-large", "agent"]);
export type PackClass = z.infer<typeof PackClass>;

export const Trust = z.enum(["trusted", "derived", "untrusted"]);
export type Trust = z.infer<typeof Trust>;

export const SectionSpec = z.object({
  id: z.string(),
  source: z.enum(["template", "stackpack", "profile", "rules", "artifact", "doc", "image", "pointers", "feedback", "task", "recap"]),
  ref: z.string().optional(),
  trust: Trust,
  placement: z.enum(["system", "user"]),
  trimmable: z.enum(["pointers-tail", "map-depth"]).optional(),
});
export type SectionSpec = z.infer<typeof SectionSpec>;

export const PackRecipe = z.object({
  stage: StageName,
  class: PackClass,
  budgetTokens: z.number().int().positive(),
  recapKey: z.string(),
  sections: z.array(SectionSpec),
});
export type PackRecipe = z.infer<typeof PackRecipe>;

export const ContextPack = z.object({
  system: z.string(),
  user: z.string(),
  images: z.array(Sha),
  pointers: z.array(z.object({ path: z.string(), reason: z.string() })),
  tools: z.array(z.string()),
  manifest: z.object({
    stage: StageName,
    model: z.string(),
    recipeVersion: z.string(),
    sections: z.array(z.object({ id: z.string(), tokens: z.number(), trimmed: z.boolean(), trust: z.string() })),
    packTokens: z.number(),
    budgetTokens: z.number(),
    countMethod: z.enum(["proxy", "vendor"]),
    fullRequestTokens: z.number().optional(),
    redactions: z.number(),
    packSha: Sha,
  }),
});
export type ContextPack = z.infer<typeof ContextPack>;

/** Budgets (context-builder §2.4; spec-stage §1 overrides for spec sub-steps). All [EVAL]. */
export const BUDGETS: Record<PackClass, number> = {
  "read-small": 15_000,
  "read-large": 30_000,
  agent: 40_000,
};
export const LOCAL_PACK_CAP = 16_000;
