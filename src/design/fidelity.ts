// Design fidelity checks that need no browser: the token/component lint over a diff,
// requirement ↔ screen traceability on our spec format, and pure comparisons of screenshot
// report data (layout, accessibility, horizontal scroll). The pixel diff itself needs
// image libraries and is not built here.
import { ARBITRARY_RE, HEX_RE, type DesignInventory } from "./inventory.js";
import { componentKey, importSpecifiers, resolveImport } from "./layout.js";
import { isUiPath } from "./size.js";
import { gitSync } from "./source.js";

export type CheckStatus = "PASS" | "FAIL" | "WARN" | "UNCHECKED";
export interface CheckResult { check: string; status: CheckStatus; detail: string; items?: string[] }

export interface DiffFile { status: "A" | "M" | "D" | "R"; path: string; added: string[] }

/** One `git diff -U0` between two commits, split per file (added lines only). */
export function diffFromGit(repo: string, base: string, head: string): DiffFile[] {
  const text = gitSync(repo, ["diff", "--no-color", "--no-ext-diff", "-U0", "-M", base, head]);
  const out: DiffFile[] = [];
  for (const chunk of text.split(/^diff --git /m).slice(1)) {
    const ls = chunk.split("\n");
    const plus = ls.find((l) => l.startsWith("+++ "));
    const minus = ls.find((l) => l.startsWith("--- "));
    const deleted = ls.some((l) => l.startsWith("deleted file mode"));
    const path = (deleted ? minus?.slice(6) : plus?.slice(6)) ?? /^a\/(.*?) b\//.exec(ls[0] ?? "")?.[1];
    if (!path) continue;
    const status = ls.some((l) => l.startsWith("new file mode")) ? "A" : deleted ? "D" : ls.some((l) => l.startsWith("rename to")) ? "R" : "M";
    out.push({ status, path, added: ls.filter((l) => l.startsWith("+") && !l.startsWith("+++ ")).map((l) => l.slice(1)) });
  }
  return out;
}

/** Hex colours in added lines, not counting theme token definitions (`--x: #fff`) in stylesheets. */
function hexHits(f: DiffFile): string[] {
  const css = /\.(css|scss|pcss)$/.test(f.path);
  return f.added.filter((l) => !(css && /^\s*--[\w-]+\s*:/.test(l))).flatMap((l) => [...`${l} `.matchAll(HEX_RE)].map((m) => `${f.path}: ${m[0]}`));
}

/**
 * Token and component lint over the change. `inventory` is taken at the approved commit (or the
 * base), so anything new shows up as new. Works for src/ and root layouts and both quote styles.
 */
export function lintDiff(inventory: DesignInventory, diff: DiffFile[]): CheckResult[] {
  const { layout } = inventory;
  const ui = diff.filter((f) => f.status !== "D" && isUiPath(f.path));
  const code = ui.filter((f) => /\.(tsx|jsx)$/.test(f.path));
  const results: CheckResult[] = [];
  if (!ui.length) return [{ check: "lint", status: "PASS", detail: "no UI files changed, nothing to check" }];

  const known = new Set([...inventory.primitives, ...inventory.composites].map((c) => c.key));
  if (!known.size) {
    results.push({ check: "lint: inventory", status: "UNCHECKED", detail: `the inventory found no components under ${layout.componentsDir}; component checks can't run (set the source root or building-blocks folder)` });
  }

  // tokens only
  const idioms = new Set(inventory.idioms);
  const hex = ui.flatMap(hexHits);
  const arb = code.flatMap((f) => f.added.flatMap((l) => [...l.matchAll(ARBITRARY_RE)].map((m) => m[0]))
    .filter((c) => !/-\[(--|var\()/.test(c) && !idioms.has(c)).map((c) => `${f.path}: ${c}`));
  const inline = code.flatMap((f) => f.added.filter((l) => /style=\{\{/.test(l)).map(() => `${f.path}: style={{…}}`));
  const offItems = [...hex, ...arb, ...inline];
  results.push({
    check: "lint: tokens only",
    status: offItems.length ? "FAIL" : "PASS",
    detail: offItems.length ? `${hex.length} hex colour(s), ${arb.length} arbitrary value(s) the building blocks don't already use, ${inline.length} inline style(s)` : `${ui.length} UI file(s) checked: no hex colours, no new arbitrary values`,
    ...(offItems.length ? { items: offItems } : {}),
  });

  // existing components only
  const addedPaths = new Set(diff.filter((f) => f.status === "A").map((f) => componentKey(f.path)));
  const unknown: string[] = [];
  const newShared: string[] = [];
  let checked = 0;
  for (const f of code) {
    for (const spec of importSpecifiers(f.added.join("\n"))) {
      const key = resolveImport(spec, f.path, layout.aliases);
      if (!key || !`${key}/`.startsWith(layout.componentsDir)) continue;
      checked++;
      if (known.has(key)) continue;
      if (addedPaths.has(key) && !`${key}/`.startsWith(layout.uiDir)) newShared.push(`${f.path} → ${spec} (added in this change)`);
      else unknown.push(`${f.path} → ${spec}`);
    }
  }
  results.push({
    check: "lint: existing components only",
    status: !known.size ? "UNCHECKED" : unknown.length ? "FAIL" : newShared.length ? "WARN" : "PASS",
    detail: unknown.length ? `${unknown.length} import(s) of components not in the inventory` : newShared.length ? `${newShared.length} import(s) of shared components added by this change` : `${checked} component import(s), all in the inventory`,
    ...(unknown.length || newShared.length ? { items: [...unknown, ...newShared] } : {}),
  });

  // no new building blocks
  const newUi = diff.filter((f) => f.status === "A" && f.path.startsWith(layout.uiDir) && /\.(tsx|jsx)$/.test(f.path)).map((f) => f.path);
  results.push({ check: "lint: no new building blocks", status: newUi.length ? "FAIL" : "PASS", detail: newUi.length ? `new: ${newUi.join(", ")}` : `${layout.uiDir} has no new files`, ...(newUi.length ? { items: newUi } : {}) });
  return results;
}

// ---------- requirement ↔ screen traceability (our spec format) ----------

export interface SpecLike { requirements: { id: string; acceptance: { id: string; level: string }[] }[] }
export interface ScreenLike { id: string; reqs: string[]; route?: string; file?: string }

/**
 * Every requirement with a UI acceptance criterion has a screen; every screen names a requirement
 * that exists. Returns the same shape as the design artifact's `mapping` field.
 */
export function traceScreens(spec: SpecLike, screens: ScreenLike[]): { unmappedReqs: string[]; orphanScreens: string[]; results: CheckResult[] } {
  const uiReqs = spec.requirements.filter((r) => r.acceptance.some((a) => a.level === "ui")).map((r) => r.id);
  const allReqs = new Set(spec.requirements.map((r) => r.id));
  const covered = new Set(screens.flatMap((s) => s.reqs));
  const unmappedReqs = uiReqs.filter((r) => !covered.has(r));
  const orphanScreens = screens.filter((s) => !s.reqs.some((r) => allReqs.has(r))).map((s) => s.id);
  return {
    unmappedReqs, orphanScreens,
    results: [
      { check: "trace: requirement → screen", status: unmappedReqs.length ? "FAIL" : "PASS", detail: unmappedReqs.length ? `no screen for ${unmappedReqs.join(", ")}` : `${uiReqs.length} requirement(s) with UI criteria all have a screen` },
      { check: "trace: screen → requirement", status: orphanScreens.length ? "FAIL" : "PASS", detail: orphanScreens.length ? `screens with no requirement: ${orphanScreens.join(", ")}` : `${screens.length} screen(s) all trace to a requirement` },
    ],
  };
}

// ---------- screenshot report comparisons (pure; data comes from the screenshot step) ----------

export interface LayoutBox { key: string; name?: string; tag: string; x: number; y: number; w: number; h: number }
export interface A11yViolation { id: string; targets?: string[] }
export interface StateReport { state: string; layout?: LayoutBox[]; axeViolations?: A11yViolation[]; horizontalScroll?: boolean }

/**
 * Same elements, same places (± tolerance px), same element types. A difference is evidence
 * for the reviewer ("REVIEW"), not a new human stop.
 */
export function compareLayout(approved: StateReport, final: StateReport, tolerancePx = 4): CheckResult {
  const before = approved.layout ?? [];
  const after = final.layout ?? [];
  const moved: string[] = [], gone: string[] = [], retagged: string[] = [];
  for (const e of before) {
    const n = after.find((x) => x.key === e.key) ?? (e.name ? after.find((x) => x.name === e.name) : undefined);
    if (!n) gone.push(e.name || e.key);
    else if (n.tag !== e.tag) retagged.push(e.name || e.key);
    else if (Math.abs(n.x - e.x) > tolerancePx || Math.abs(n.y - e.y) > tolerancePx || Math.abs(n.w - e.w) > tolerancePx || Math.abs(n.h - e.h) > tolerancePx) moved.push(e.name || e.key);
  }
  const bad = moved.length + gone.length + retagged.length;
  return {
    check: `layout: ${final.state}`,
    status: bad ? "WARN" : "PASS",
    detail: bad ? `${moved.length} moved or resized, ${gone.length} missing, ${retagged.length} changed element type (goes into the PR evidence)` : `${before.length} elements in place`,
    ...(bad ? { items: [...moved.map((m) => `moved: ${m}`), ...gone.map((m) => `missing: ${m}`), ...retagged.map((m) => `element type changed: ${m}`)] } : {}),
  };
}

/** New accessibility problems fail; a new element breaking a rule the page already broke counts as new. */
export function compareA11y(approved: StateReport, final: StateReport): CheckResult {
  const seen = new Set((approved.axeViolations ?? []).flatMap((v) => (v.targets?.length ? v.targets : ["*"]).map((t) => `${v.id}|${t}`)));
  const fresh: string[] = [], inherited: string[] = [];
  for (const v of final.axeViolations ?? []) {
    for (const t of v.targets?.length ? v.targets : ["*"]) {
      const k = `${v.id}|${t}`;
      (seen.has(k) || (t === "*" && [...seen].some((s) => s.startsWith(`${v.id}|`))) ? inherited : fresh).push(`${v.id} at ${t}`);
    }
  }
  if (fresh.length) return { check: `accessibility: ${final.state}`, status: "FAIL", detail: `new: ${fresh.join(", ")}`, items: fresh };
  if (inherited.length) return { check: `accessibility: ${final.state}`, status: "WARN", detail: `already there before this change: ${inherited.join(", ")}` };
  return { check: `accessibility: ${final.state}`, status: "PASS", detail: "no problems found" };
}

export function compareReports(approved: StateReport[], final: StateReport[]): CheckResult[] {
  const out: CheckResult[] = [];
  for (const f of final) {
    const a = approved.find((x) => x.state === f.state);
    if (!a) { out.push({ check: `state: ${f.state}`, status: "FAIL", detail: "no approved screenshot for this state" }); continue; }
    out.push(compareLayout(a, f), compareA11y(a, f));
    if (f.horizontalScroll) out.push({ check: `responsive: ${f.state}`, status: "FAIL", detail: "the page scrolls sideways" });
  }
  for (const a of approved) if (!final.some((f) => f.state === a.state)) out.push({ check: `state: ${a.state}`, status: "FAIL", detail: "approved state missing from the final screenshots" });
  return out;
}

export function overall(results: CheckResult[]): "pass" | "fail" | "unchecked" {
  if (results.some((r) => r.status === "FAIL")) return "fail";
  if (results.some((r) => r.status === "UNCHECKED")) return "unchecked";
  return "pass";
}
