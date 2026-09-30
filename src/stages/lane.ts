// The light lane: a small, low-risk change gets a smaller, cheaper pipeline (one spec draft, one
// rework, a lighter critic, a Sonnet test writer with tight limits). Everything else keeps the
// full lane. Decided from intake (before the plan) and the plan's size (after it).
import type { z } from "zod";
import type { IntentBody } from "../contracts/index.js";

type Intent = Pick<z.infer<typeof IntentBody>, "risk" | "rigor" | "changeClass">;

/** Spec side: low risk, and either intake chose light rigor or it's a bug fix. */
export function lightSpec(intent: Intent): boolean {
  return intent.risk === "low" && (intent.rigor === "light" || intent.changeClass === "bugfix");
}

/** Build side: the spec side is light and the plan is small. */
export function lightBuild(intent: Intent, complexity: string | undefined): boolean {
  return lightSpec(intent) && complexity === "S";
}

/** Limits per lane. The full lane is what every run used before the light lane existed. */
export const LANE = {
  light: { drafts: 1, maxRepairs: 1, criticEffort: "medium" as const, groundTurns: 8, testWriterTurns: 25, maxCharacterisation: 2 },
  full: { drafts: 3, maxRepairs: 3, criticEffort: undefined, groundTurns: 12, testWriterTurns: 60, maxCharacterisation: undefined },
};
