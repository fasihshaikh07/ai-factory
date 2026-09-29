// Size of a UI change: no UI / screen tweak / new screen / design-system change.
// Works from a planned file list (before any code exists) or from a git range (after the
// build, for the size-cap check). Deterministic, no model.
import { createRequire } from "node:module";
import { basename, posix } from "node:path";
import { cssTokens } from "./inventory.js";
import { detectLayout, pageOf, type AppLayout } from "./layout.js";
import { gitSource, gitSync, type FileSource } from "./source.js";

export const LEVELS = ["none", "tweak", "new-screen", "design-system"] as const;
export type Level = (typeof LEVELS)[number];

export const LEVEL_NAMES: Record<Level, string> = {
  none: "no UI",
  tweak: "screen tweak",
  "new-screen": "new screen",
  "design-system": "design-system change",
};

export const LEVEL_WORK: Record<Level, string> = {
  none: "no design step",
  tweak: "a short screen note (regions, components, states); no mock; checks: lint, accessibility, before/after screenshot",
  "new-screen": "screen note + a mock in the real app on a design branch + state screenshots at 390 and 1280 px; full fidelity check",
  "design-system": "as for a new screen, plus a token or building-block diff for a human to accept",
};

export const rank = (l: Level): number => LEVELS.indexOf(l);
export const maxLevel = (a: Level, b: Level): Level => (rank(b) > rank(a) ? b : a);

export type Change = "add" | "modify" | "delete";
export interface PlannedFile { path: string; change: Change }
export interface SizeInput { files: PlannedFile[]; newApp?: boolean }

/** File contents before and after (git mode only). */
export interface ContentProbe { before(path: string): string | undefined; after(path: string): string | undefined }

export interface SizeOptions {
  layout?: AppLayout;
  probe?: ContentProbe;
  /** Count navigation edits (sidebar, header, nav) as design-system changes, like the original rule. Default false. */
  navRaises?: boolean;
}

export interface SizeResult {
  level: Level;
  name: string;
  work: string;
  mode: "plan" | "git";
  uiFiles: number;
  /** Plain reasons, one per file that mattered, biggest first. */
  reasons: string[];
}

const UI_EXT = /\.(tsx|jsx|css|scss|sass|less|pcss|vue|svelte)$/;
const NOT_UI = /\.(test|spec|stories|story)\.|(^|\/)(__tests__|__mocks__|\.storybook|e2e|tests?|cypress|playwright|emails?|\.react-email|public|scripts)\//;
const TOKEN_CSS = /(^|\/)(globals?|theme|tokens|variables|index|app|tailwind)\.(css|scss|pcss)$/;
const TOKEN_CONFIG = /(^|\/)(tailwind\.config\.(js|cjs|mjs|ts)|(theme|tokens)\.(ts|js|json))$/;
const NAV = /(^|\/)(app-|site-|main-|mobile-)?(sidebar|nav|navbar|navigation|header|menu)(-data|-items|-links)?\.(tsx|jsx|ts|js)$/i;
const DIALOG_WORDS = new Set(["dialog", "drawer", "sheet", "modal", "form", "wizard", "dialogs", "drawers", "sheets", "modals", "forms", "wizards"]);

/** Words of a file name: "user-form.tsx" → [user, form]; "EditUserDialog.tsx" → [edit, user, dialog]. */
export function nameWords(path: string): string[] {
  return basename(path).replace(/\.[^.]+$/, "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s._-]+/).map((w) => w.toLowerCase()).filter(Boolean);
}

export function isUiPath(path: string): boolean {
  return UI_EXT.test(path) && !NOT_UI.test(path);
}

// ---------- line-level checks (git mode) ----------

function lines(text: string | undefined): string[] {
  return (text ?? "").split("\n");
}

/** Changed lines (removed, added) between two texts, as multisets (order ignored). */
export function changedLines(before: string | undefined, after: string | undefined): { removed: string[]; added: string[] } {
  const count = new Map<string, number>();
  for (const l of lines(before)) count.set(l, (count.get(l) ?? 0) + 1);
  const added: string[] = [];
  for (const l of lines(after)) {
    const c = count.get(l);
    if (c) count.set(l, c - 1); else added.push(l);
  }
  const removed = [...count.entries()].flatMap(([l, c]) => Array<string>(c).fill(l));
  return { removed: removed.filter((l) => l.trim()), added: added.filter((l) => l.trim()) };
}

function tokenize(ls: string[]): string[] {
  return ls.join("\n").match(/[\w$.#%-]+/g) ?? [];
}

/** The teammate's exception: same bag of tokens before and after (a class-sort pass). */
export function isPureReorder(before: string | undefined, after: string | undefined): boolean {
  const { removed, added } = changedLines(before, after);
  const a = tokenize(added).sort(), b = tokenize(removed).sort();
  return a.length > 0 && a.length === b.length && a.every((t, i) => t === b[i]);
}

type Ts = { transpileModule(src: string, o: { compilerOptions: Record<string, unknown>; fileName?: string }): { outputText: string } };
let ts: Ts | null | undefined;
function typescript(): Ts | null {
  if (ts === undefined) {
    try { ts = createRequire(import.meta.url)("typescript") as Ts; } catch { ts = null; }
  }
  return ts;
}

const IMPORT_STMT = /^\s*(import|export)\s[\s\S]*?\bfrom\s*["'][^"']+["'];?|^\s*import\s*["'][^"']+["'];?/gm;

/** What the code does once types are removed, with imports stripped and whitespace collapsed. */
function runtimeShape(code: string, fileName: string, dropImports: boolean): string {
  const t = typescript();
  let out = code;
  if (t) {
    try {
      out = t.transpileModule(code, { fileName, compilerOptions: { jsx: 1 /* preserve */, target: 99, module: 99, removeComments: true, verbatimModuleSyntax: false } }).outputText;
    } catch { /* fall back to the source */ }
  }
  if (dropImports) out = out.replace(IMPORT_STMT, "");
  return out.replace(/\s+/g, "");
}

/** A change to a building block that only touches types (e.g. ElementRef → ComponentRef) or imports. */
export function isTypeOrImportOnly(path: string, before: string | undefined, after: string | undefined): "type-only" | "import-only" | undefined {
  if (before === undefined || after === undefined) return undefined;
  if (!/\.(tsx|ts|jsx|js)$/.test(path)) return undefined;
  if (typescript() && runtimeShape(before, path, false) === runtimeShape(after, path, false)) return "type-only";
  const { removed, added } = changedLines(before, after);
  const importish = (l: string) => /^\s*(import\b|export\s.*\bfrom\b|\}\s*from\s|["']use client["'];?$)/.test(l) || /^\s*[\w$]+,?\s*$/.test(l);
  if ([...removed, ...added].every(importish) && runtimeShape(before, path, true) === runtimeShape(after, path, true)) return "import-only";
  return undefined;
}

/** Did a stylesheet change its custom properties (tokens) or `@theme` block? */
export function cssTokensChanged(before: string | undefined, after: string | undefined): boolean {
  const key = (t: string | undefined) => cssTokens(t ?? "").map((d) => `${d.bucket}|${d.name}|${d.value}`).sort().join("\n");
  if (key(before) !== key(after)) return true;
  const { removed, added } = changedLines(before, after);
  return [...removed, ...added].some((l) => /@theme\b/.test(l));
}

const THEME_KEYS = /\b(colors?|fontFamily|fontSize|borderRadius|spacing|extend|keyframes|animation|screens|boxShadow|theme|container)\b/;

function tailwindThemeChanged(before: string | undefined, after: string | undefined): boolean {
  const { removed, added } = changedLines(before, after);
  const changed = [...removed, ...added].filter((l) => !/^\s*(\/\/|import\b|const\s+\w+\s*=\s*require)/.test(l));
  // content globs and plugin lists are build settings, not the look
  return changed.some((l) => THEME_KEYS.test(l) || /--[\w-]+|hsl\(|rgb\(|#[0-9a-f]{3,8}\b|\d+(px|rem)/i.test(l));
}

// ---------- the classifier ----------

interface Hit { level: Level; reason: string }

export function sizeChange(input: SizeInput, opts: SizeOptions = {}): SizeResult {
  const layout = opts.layout;
  const probe = opts.probe;
  const mode = probe ? "git" : "plan";
  const uiDirs = layout ? [layout.uiDir] : ["components/ui/", "src/components/ui/"];
  const inUi = (p: string) => uiDirs.some((d) => p.startsWith(d)) || (!layout && /(^|\/)components\/ui\//.test(p));
  const hits: Hit[] = [];
  let uiFiles = 0;

  if (input.newApp) hits.push({ level: "design-system", reason: "new app: its look has to be chosen" });

  for (const f of input.files) {
    const p = f.path.replace(/\\/g, "/").replace(/^\.\//, "");
    const page = pageOf(p, layout);
    const tokenConfig = TOKEN_CONFIG.test(p) && !NOT_UI.test(p);
    if (!isUiPath(p) && !tokenConfig && !(page && /\.(ts|js|mdx|md)$/.test(p))) continue;
    uiFiles++;
    const before = probe?.before(p);
    const after = probe?.after(p);

    if (f.change === "delete") {
      hits.push({ level: "tweak", reason: `${p} deleted (a deletion never makes the change bigger than a screen tweak)` });
      continue;
    }
    if (f.change === "add" && page) { hits.push({ level: "new-screen", reason: `new page ${p} (route ${page.route})` }); continue; }

    if (/\.(tsx|jsx)$/.test(p) && inUi(p)) {
      if (f.change === "add") { hits.push({ level: "design-system", reason: `new building block ${p}` }); continue; }
      if (probe) {
        if (isPureReorder(before, after)) { hits.push({ level: "tweak", reason: `${p}: pure reorder (same classes before and after), not a design-system change` }); continue; }
        const only = isTypeOrImportOnly(p, before, after);
        if (only) { hits.push({ level: "tweak", reason: `${p}: ${only === "type-only" ? "types only" : "imports only"}, the building block looks the same` }); continue; }
        hits.push({ level: "design-system", reason: `building block ${p} changed` });
      } else hits.push({ level: "design-system", reason: `building block ${p} planned to change` });
      continue;
    }

    if (/\.(css|scss|pcss)$/.test(p)) {
      if (probe) {
        if (isPureReorder(before, after)) { hits.push({ level: "tweak", reason: `${p}: pure reorder` }); continue; }
        if (cssTokensChanged(before, after)) { hits.push({ level: "design-system", reason: `${p}: theme tokens changed` }); continue; }
        hits.push({ level: "tweak", reason: `${p}: stylesheet edit, tokens unchanged` });
      } else if (/(^|\/)(theme|tokens|variables)\.(css|scss|pcss)$/.test(p)) {
        hits.push({ level: "design-system", reason: `${p}: theme file planned to ${f.change === "add" ? "be added" : "change"}` });
      } else {
        hits.push({ level: "tweak", reason: `${p}: stylesheet planned to change${TOKEN_CSS.test(p) ? " (becomes a design-system change if it edits theme tokens; the size-cap check after the build will tell)" : ""}` });
      }
      continue;
    }

    if (tokenConfig) {
      if (probe) {
        if (isPureReorder(before, after)) { hits.push({ level: "none", reason: `${p}: pure reorder` }); continue; }
        if (tailwindThemeChanged(before, after)) hits.push({ level: "design-system", reason: `${p}: theme settings changed` });
        else hits.push({ level: "none", reason: `${p}: build settings only (content paths, plugins)` });
      } else hits.push({ level: "design-system", reason: `${p}: theme settings planned to change` });
      continue;
    }

    if (f.change === "add" && nameWords(p).some((w) => DIALOG_WORDS.has(w))) {
      hits.push({ level: "new-screen", reason: `new dialog or form ${p}` });
      continue;
    }
    if (NAV.test(p)) {
      if (opts.navRaises && !(probe && isPureReorder(before, after))) hits.push({ level: "design-system", reason: `navigation ${p} changed` });
      else hits.push({ level: "tweak", reason: `navigation ${p} ${f.change === "add" ? "added" : "changed"} (shows on every screen; check it on the card)` });
      continue;
    }
    hits.push({ level: "tweak", reason: `${p} ${f.change === "add" ? "added" : "changed"}` });
  }

  const level = hits.reduce<Level>((a, h) => maxLevel(a, h.level), "none");
  const reasons = [...hits].sort((a, b) => rank(b.level) - rank(a.level)).map((h) => `${LEVEL_NAMES[h.level]}: ${h.reason}`);
  // keep the list short: every reason at the top level, at most 5 of the rest
  const top = reasons.filter((r) => r.startsWith(LEVEL_NAMES[level]));
  const rest = reasons.filter((r) => !r.startsWith(LEVEL_NAMES[level]));
  const shown = [...top, ...rest.slice(0, 5), ...(rest.length > 5 ? [`… and ${rest.length - 5} more smaller changes`] : [])];
  return { level, name: LEVEL_NAMES[level], work: LEVEL_WORK[level], mode, uiFiles, reasons: shown };
}

// ---------- inputs ----------

/** `git diff --name-status` between two commits (renames count as a change to the new path). */
export function gitChanges(repo: string, base: string, head: string): PlannedFile[] {
  const parts = gitSync(repo, ["diff", "--name-status", "-M", "-z", "--no-ext-diff", base, head]).split("\0");
  const out: PlannedFile[] = [];
  for (let i = 0; i < parts.length && parts[i]; ) {
    const s = parts[i++]!;
    if (s.startsWith("R") || s.startsWith("C")) {
      i++; // old path
      out.push({ path: parts[i++]!, change: s.startsWith("C") ? "add" : "modify" });
    } else out.push({ path: parts[i++]!, change: s === "A" ? "add" : s === "D" ? "delete" : "modify" });
  }
  return out;
}

export function sizeFromGit(repo: string, base: string, head: string, opts: Omit<SizeOptions, "probe"> = {}): SizeResult {
  const before = gitSource(repo, base), after = gitSource(repo, head);
  const layout = opts.layout ?? detectLayout(after);
  return sizeChange({ files: gitChanges(repo, base, head) }, { ...opts, layout, probe: { before: (p) => before.read(p), after: (p) => after.read(p) } });
}

/**
 * The plan's file scope (paths or narrow globs) → planned changes, using the files that exist
 * at the base commit: an existing path is a modify, a missing one an add. A glob that matches
 * nothing under an app-router folder is read as a planned new page.
 */
export function plannedChanges(fileScope: string[], existing: FileSource | string[], layout?: AppLayout): PlannedFile[] {
  const files = Array.isArray(existing) ? existing : existing.list();
  const have = new Set(files);
  const out = new Map<string, PlannedFile>();
  for (const raw of fileScope) {
    const p = raw.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!/[*?{]/.test(p)) { out.set(p, { path: p, change: have.has(p) ? "modify" : "add" }); continue; }
    const rx = globRx(p);
    const matched = files.filter((f) => rx.test(f));
    for (const f of matched) if (!out.has(f)) out.set(f, { path: f, change: "modify" });
    if (!matched.length) {
      const dir = p.replace(/\/?[^/]*[*?{].*$/, "");
      if (/^(src\/)?app\//.test(`${dir}/`) && (!layout || layout.framework === "next" || layout.framework === "unknown")) {
        out.set(`${dir}/page.tsx`, { path: posix.join(dir, "page.tsx"), change: "add" });
      }
    }
  }
  return [...out.values()];
}

function globRx(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "{") { const end = glob.indexOf("}", i); re += `(?:${glob.slice(i + 1, end).split(",").map((a) => a.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}
