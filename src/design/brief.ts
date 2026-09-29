// Brief cleaner: turns an UNTRUSTED design extract (a Figma API export, what a tool-less vision
// model read from screenshots, a brand PDF) into a design brief made only of typed fields.
// It is an allow-list: anything that doesn't fit a field is dropped and logged.
//
// Free-text notes are kept apart. Following the context builder's rule (untrusted text only in
// read-only steps), `writerView` never contains them: a writing step (the mock, implement) gets
// typed fields only. Notes may go to a read-only design step, fenced as untrusted.
import { z } from "zod";
import type { DesignInventory } from "./inventory.js";
import { GOOGLE_FONTS } from "./google-fonts.js";

export const RawExtract = z.object({
  source: z.unknown().optional(),
  palette: z.array(z.unknown()).optional(),
  fonts: z.array(z.unknown()).optional(),
  spacing: z.array(z.unknown()).optional(),
  radius: z.unknown().optional(),
  screens: z.array(z.unknown()).optional(),
  notes: z.array(z.unknown()).optional(),
}).passthrough();

export interface CleanScreen { id: string; regions: { name: string; component: string | null; needsMapping?: true }[] }
export interface WriterBrief {
  palette: { name: string; hex: string }[];
  fonts: string[];
  spacingPx: number[];
  radiusPx: number | null;
  screens: CleanScreen[];
}
export interface CleanBrief extends WriterBrief {
  source: "figma" | "screenshot" | "brand-guide" | "unknown";
  /** Untrusted free text. Read-only steps only; never in a writer's pack. */
  untrustedNotes: string[];
}
export interface Dropped { where: string; value: string; reason: string }

export interface BriefOptions {
  /** The project's own brand fonts (configured by a human), allowed even if not on Google Fonts. */
  brandFonts?: string[];
  maxNotes?: number;
}

const GENERIC_FONTS = ["system-ui", "sans-serif", "serif", "monospace", "ui-sans-serif", "ui-serif", "ui-monospace", "cursive"];
const INJECTION = /\b(ignore|disregard|forget|override)\b.{0,40}\b(instruction|previous|above|rules|prompt)|\b(system prompt|you are now|assistant:|developer mode|jailbreak)\b|<\/?(script|iframe)|javascript:|\b(fetch|curl|wget|eval|exec)\s*\(|https?:\/\/|\b(api[_-]?key|token|password|secret)\b/i;
const NAME = /^[A-Za-z][A-Za-z0-9 _-]{0,31}$/;
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const SOURCES = new Set(["figma", "screenshot", "brand-guide"]);

/** Fold look-alike letters (full-width, ligatures) so the filters see what a model would read. */
export function fold(text: string): string {
  return text.normalize("NFKC").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, "");
}

export function cleanBrief(rawInput: unknown, inventory: Pick<DesignInventory, "primitives" | "composites">, opts: BriefOptions = {}): { brief: CleanBrief; dropped: Dropped[] } {
  const parsed = RawExtract.safeParse(rawInput);
  const raw = parsed.success ? parsed.data : {};
  const dropped: Dropped[] = [];
  const drop = (where: string, value: unknown, reason: string) => dropped.push({ where, value: String(typeof value === "object" ? JSON.stringify(value) : value).slice(0, 80), reason });
  if (!parsed.success) drop("(root)", rawInput, "not an object with the expected fields");

  const brand = new Set((opts.brandFonts ?? []).map((f) => f.trim()));
  const components = new Set([...inventory.primitives, ...inventory.composites].flatMap((c) => c.exports));
  const name = (where: string, v: unknown): string | null => {
    if (typeof v === "string") {
      const t = fold(v).trim();
      if (NAME.test(t) && !INJECTION.test(t)) return t;
    }
    drop(where, v, "not a plain name");
    return null;
  };
  const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

  const brief: CleanBrief = {
    source: typeof raw.source === "string" && SOURCES.has(raw.source) ? (raw.source as CleanBrief["source"]) : "unknown",
    palette: [], fonts: [], spacingPx: [], radiusPx: null, screens: [], untrustedNotes: [],
  };

  for (const [i, c0] of (raw.palette ?? []).entries()) {
    const c = obj(c0);
    const hex = typeof c.hex === "string" ? c.hex.trim() : "";
    if (!HEX.test(hex)) { drop(`palette[${i}].hex`, c.hex, "not a hex colour"); continue; }
    const n = name(`palette[${i}].name`, c.name);
    if (n) brief.palette.push({ name: n, hex: hex.toLowerCase() });
  }
  for (const [i, f0] of (raw.fonts ?? []).entries()) {
    const f = typeof f0 === "string" ? fold(f0).trim() : "";
    if (f && (GOOGLE_FONTS.has(f) || GENERIC_FONTS.includes(f) || brand.has(f))) { if (!brief.fonts.includes(f)) brief.fonts.push(f); }
    else drop(`fonts[${i}]`, f0, "not a known font family (add the project's brand fonts to the config to allow them)");
  }
  for (const [i, s] of (raw.spacing ?? []).entries()) {
    if (typeof s === "number" && Number.isFinite(s) && s >= 0 && s <= 256) brief.spacingPx.push(Math.round(s));
    else drop(`spacing[${i}]`, s, "not a spacing value (0 to 256 px)");
  }
  if (typeof raw.radius === "number" && Number.isFinite(raw.radius) && raw.radius >= 0 && raw.radius <= 64) brief.radiusPx = raw.radius;
  else if (raw.radius !== undefined) drop("radius", raw.radius, "not a radius (0 to 64 px)");

  for (const [i, s0] of (raw.screens ?? []).entries()) {
    const s = obj(s0);
    const id = name(`screens[${i}].name`, s.name);
    if (!id) continue;
    const regions: CleanScreen["regions"] = [];
    for (const [j, r0] of (Array.isArray(s.regions) ? s.regions : []).entries()) {
      const r = obj(r0);
      const rn = name(`screens[${i}].regions[${j}].name`, r.name);
      if (!rn) continue;
      const comp = typeof r.component === "string" ? fold(r.component).trim() : "";
      if (components.has(comp)) regions.push({ name: rn, component: comp });
      else {
        regions.push({ name: rn, component: null, needsMapping: true });
        drop(`screens[${i}].regions[${j}].component`, comp, "not in the component inventory; the design step maps it to an existing one");
      }
    }
    brief.screens.push({ id, regions });
  }

  // Free text: filtered as a first pass, but the real protection is that it never reaches a
  // writing step and that the human approves the resulting design on the card.
  const maxNotes = opts.maxNotes ?? 10;
  for (const [i, t] of (raw.notes ?? []).entries()) {
    if (typeof t !== "string") { drop(`notes[${i}]`, t, "not text"); continue; }
    const clean = fold(t);
    if (INJECTION.test(clean)) { drop(`notes[${i}]`, t, "instruction-like text"); continue; }
    if (brief.untrustedNotes.length >= maxNotes) { drop(`notes[${i}]`, t, "too many notes"); continue; }
    brief.untrustedNotes.push(clean.slice(0, 280));
  }
  return { brief, dropped };
}

/** What a writing step (mock, implement) may see: typed fields only, never the notes. */
export function writerView(brief: CleanBrief): WriterBrief {
  return {
    palette: brief.palette.map((p) => ({ ...p })),
    fonts: [...brief.fonts],
    spacingPx: [...brief.spacingPx],
    radiusPx: brief.radiusPx,
    screens: brief.screens.map((s) => ({ id: s.id, regions: s.regions.map((r) => ({ ...r })) })),
  };
}
