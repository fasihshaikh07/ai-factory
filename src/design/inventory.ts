// Design inventory: a read-only scan of a React/Next repo (stack, tokens, building blocks,
// shared components, pages, off-system styling). No network, no model, deterministic:
// the same files always give the same result, so it is cheap to rerun on every run.
import { componentKey, depsOf, detectLayout, importSpecifiers, pageOf, resolveImport, type AppLayout, type PageKind } from "./layout.js";
import type { FileSource } from "./source.js";

export interface ComponentInfo { path: string; key: string; exports: string[]; variants: Record<string, string[]>; uses: number }
export interface PageEntry { path: string; kind: PageKind; route: string; layout: string[]; heading: string | null }
export type Verdict = "consistent" | "partial" | "none";

export interface DesignInventory {
  schemaVersion: 1;
  layout: AppLayout;
  stack: {
    framework: string;
    styling: string;
    componentSystem: string;
    /** why we think so: "components.json", "components/ui + radix", ... */
    componentSystemEvidence: string;
    primitives: string | null;
    icons: string[]; forms: string[]; tables: string[]; toasts: string[];
  };
  tokens: { light: number; dark: number; theme: number; total: number; names: { light: string[]; dark: string[]; theme: string[] } };
  primitives: ComponentInfo[];
  composites: ComponentInfo[];
  pages: PageEntry[];
  /** Arbitrary Tailwind values the app's own building blocks already use (allowed "house idioms"). */
  idioms: string[];
  offSystem: { hexColors: number; arbitraryValues: number; inlineStyle: number; classNameCount: number; ratio: number; examples: string[] };
  verdict: Verdict;
  rules: string[];
}

const SOURCE_EXT = /\.(tsx|jsx)$/;
const NOT_SOURCE = /\.(test|spec|stories)\.|(^|\/)(__tests__|__mocks__|\.storybook)\//;

// ---------- tokens ----------

export type TokenBucket = "light" | "dark" | "theme";
export interface TokenDecl { bucket: TokenBucket; name: string; value: string }

function bucketOf(stack: string[]): TokenBucket | undefined {
  const inner = stack[stack.length - 1] ?? "";
  if (/^@theme\b/.test(inner)) return "theme";
  const darkMedia = stack.some((s) => /^@media[^{]*prefers-color-scheme\s*:\s*dark/.test(s));
  for (const sel of inner.split(",").map((s) => s.trim())) {
    if (/^(:root|html)?(\.dark|\[data-theme=["']?dark["']?\]|\[data-mode=["']?dark["']?\])$/.test(sel) || /^:is\(\.dark \*\)$/.test(sel) || /^\.dark\s+:root$/.test(sel)) return "dark";
    if (/^(:root|html)(:not\(\.dark\))?$/.test(sel) || /^(:root|html)?(\.light|\[data-theme=["']?light["']?\])$/.test(sel)) return darkMedia ? "dark" : "light";
  }
  return undefined;
}

/** CSS custom properties declared for the light theme, the dark theme and Tailwind v4 `@theme`. */
export function cssTokens(css: string): TokenDecl[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out: TokenDecl[] = [];
  const stack: string[] = [];
  let buf = "";
  const flush = () => {
    const m = /^\s*--([\w-]+)\s*:\s*([\s\S]+?)\s*$/.exec(buf);
    const b = bucketOf(stack);
    if (m && b) out.push({ bucket: b, name: m[1]!, value: m[2]!.replace(/\s+/g, " ") });
    buf = "";
  };
  for (const c of text) {
    if (c === "{") { stack.push(buf.trim().replace(/\s+/g, " ")); buf = ""; }
    else if (c === "}") { flush(); stack.pop(); }
    else if (c === ";") flush();
    else buf += c;
  }
  return out;
}

// ---------- components ----------

function exportsOf(code: string): string[] {
  const names: string[] = [];
  for (const m of code.matchAll(/export\s+(?:default\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/g)) names.push(m[1]!);
  for (const m of code.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const p = part.trim().replace(/^type\s+/, "");
      if (!p) continue;
      const as = /\bas\s+(\w+)$/.exec(p);
      names.push(as ? as[1]! : p.split(/\s+/)[0]!);
    }
  }
  return [...new Set(names.filter((n) => n && n !== "default"))];
}

/** Balanced `{...}` block that starts at `open` (the index of "{"). */
function block(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/** Top-level keys of an object literal body. */
function topKeys(body: string): string[] {
  const keys: string[] = [];
  let depth = 0;
  let start = true;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === "," && depth === 0) start = true;
    else if (start && depth === 0 && !/\s/.test(c)) {
      const m = /^["']?([\w-]+)["']?\s*:/.exec(body.slice(i));
      if (m) keys.push(m[1]!);
      start = false;
    }
  }
  return keys;
}

/** cva-style variants: { variant: [default, destructive], size: [sm, lg] }. */
export function variantsOf(code: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of code.matchAll(/\bvariants\s*:\s*\{/g)) {
    const body = block(code, m.index! + m[0].length - 1);
    for (const g of body.matchAll(/(?:^|[\s,{])["']?([\w-]+)["']?\s*:\s*\{/g)) {
      if (out[g[1]!]) continue;
      const groupBody = block(body, g.index! + g[0].length - 1);
      out[g[1]!] = topKeys(groupBody);
    }
  }
  return out;
}

// ---------- off-system styling ----------

export const HEX_RE = /#[0-9a-fA-F]{3,8}\b(?=['"`\s;),])/g;
/** Arbitrary Tailwind values like `p-[13px]`, `bg-[#fff]`; not variants like `data-[state=open]:`, not CSS-variable references. */
export const ARBITRARY_RE = /(?<![\w\-[])(?:[\w-]+:)*[a-z][\w-]*-\[[^\]\s"'`]+\](?![:/])/g;

export function arbitraryValues(text: string): string[] {
  return [...text.matchAll(ARBITRARY_RE)].map((m) => m[0]).filter((c) => !/-\[(--|var\()/.test(c));
}

// ---------- the scan ----------

export interface InventoryOptions { sourceRoot?: string; uiDir?: string }

export function buildInventory(src: FileSource, opts: InventoryOptions = {}): DesignInventory {
  const layout = detectLayout(src, { ...(opts.sourceRoot !== undefined ? { sourceRoot: opts.sourceRoot } : {}), ...(opts.uiDir ? { uiDir: opts.uiDir } : {}) });
  const files = src.list();
  const deps = depsOf(src);
  const code = files.filter((f) => SOURCE_EXT.test(f) && !NOT_SOURCE.test(f));
  const text = new Map(code.map((f) => [f, src.read(f) ?? ""]));

  // 1. stack
  const uiFiles = code.filter((f) => f.startsWith(layout.uiDir));
  const radix = Object.keys(deps).some((d) => d.startsWith("@radix-ui/") || d === "radix-ui");
  const baseUi = Object.keys(deps).some((d) => d.startsWith("@base-ui"));
  let componentSystem = "none-detected";
  let evidence = "";
  if (src.read("components.json") !== undefined) { componentSystem = "shadcn"; evidence = "components.json"; }
  else if (uiFiles.length >= 3 && (radix || baseUi)) { componentSystem = "shadcn"; evidence = `${layout.uiDir} (${uiFiles.length} files) + ${radix ? "radix" : "base-ui"} packages`; }
  else if (deps["@mui/material"]) { componentSystem = "mui"; evidence = "@mui/material"; }
  else if (deps["@chakra-ui/react"]) { componentSystem = "chakra"; evidence = "@chakra-ui/react"; }
  else if (deps.antd) { componentSystem = "antd"; evidence = "antd"; }
  else if (deps["@mantine/core"]) { componentSystem = "mantine"; evidence = "@mantine/core"; }
  const tw = deps.tailwindcss ?? deps["@tailwindcss/vite"] ?? deps["@tailwindcss/postcss"];
  const stack = {
    framework: layout.framework,
    styling: tw ? `tailwind@${tw}` : deps["styled-components"] ? "styled-components" : deps["@emotion/react"] ? "emotion" : files.some((f) => /\.module\.(css|scss)$/.test(f)) ? "css-modules" : "css",
    componentSystem, componentSystemEvidence: evidence,
    primitives: radix ? "radix" : baseUi ? "base-ui" : null,
    icons: ["lucide-react", "@radix-ui/react-icons", "@heroicons/react", "react-icons", "@tabler/icons-react"].filter((d) => deps[d]),
    forms: ["react-hook-form", "formik", "@tanstack/react-form"].filter((d) => deps[d]),
    tables: ["@tanstack/react-table"].filter((d) => deps[d]),
    toasts: ["sonner", "react-hot-toast", "react-toastify"].filter((d) => deps[d]),
  };

  // 2. tokens (all CSS files; Tailwind v4 @theme included)
  const names: Record<TokenBucket, Set<string>> = { light: new Set(), dark: new Set(), theme: new Set() };
  for (const f of files.filter((f) => /\.(css|scss|pcss)$/.test(f) && !NOT_SOURCE.test(f))) {
    for (const t of cssTokens(src.read(f) ?? "")) names[t.bucket].add(t.name);
  }
  const allTokens = new Set([...names.light, ...names.theme]);

  // 3. components with usage counts (alias and relative imports, both quote styles)
  const importCount = new Map<string, number>();
  for (const [f, t] of text) {
    for (const spec of new Set(importSpecifiers(t))) {
      const key = resolveImport(spec, f, layout.aliases);
      if (key) importCount.set(key, (importCount.get(key) ?? 0) + 1);
    }
  }
  const describe = (f: string): ComponentInfo => {
    const t = text.get(f) ?? "";
    const key = componentKey(f);
    return { path: f, key, exports: exportsOf(t), variants: variantsOf(t), uses: importCount.get(key) ?? 0 };
  };
  const byUse = (a: ComponentInfo, b: ComponentInfo) => b.uses - a.uses || a.path.localeCompare(b.path);
  const primitives = uiFiles.map(describe).sort(byUse);
  const composites = code.filter((f) => f.startsWith(layout.componentsDir) && !f.startsWith(layout.uiDir)).map(describe).sort(byUse);

  // 4. pages
  const pages: PageEntry[] = [];
  for (const f of files) {
    const p = pageOf(f, layout);
    if (!p) continue;
    const t = src.read(f) ?? "";
    pages.push({
      path: f, kind: p.kind, route: p.route,
      layout: [...new Set([...t.matchAll(/<([A-Z]\w*)\b/g)].map((m) => m[1]!))].slice(0, 12),
      heading: /<h[12][^>]*className=(["'])([^"']+)\1/.exec(t)?.[2] ?? null,
    });
  }

  // 5. house idioms and off-system styling
  const idioms = new Set<string>();
  for (const f of uiFiles) for (const a of arbitraryValues(text.get(f) ?? "")) idioms.add(a);
  const off = { hexColors: 0, arbitraryValues: 0, inlineStyle: 0, examples: [] as string[] };
  let classNameCount = 0;
  for (const f of code) {
    const t = text.get(f) ?? "";
    classNameCount += (t.match(/className=/g) ?? []).length;
    if (f.startsWith(layout.uiDir) || /\/assets\//.test(f)) continue;
    const note = (what: string) => { if (off.examples.length < 12) off.examples.push(`${f}: ${what}`); };
    for (const m of t.matchAll(HEX_RE)) { off.hexColors++; note(m[0]); }
    for (const a of arbitraryValues(t)) { off.arbitraryValues++; note(a); }
    for (const _ of t.matchAll(/style=\{\{/g)) { off.inlineStyle++; note("style={{…}}"); }
  }
  const ratio = (off.hexColors + off.arbitraryValues + off.inlineStyle) / Math.max(classNameCount, 1);
  const verdict: Verdict = componentSystem !== "none-detected" && allTokens.size >= 10 && ratio < 0.05
    ? "consistent" : allTokens.size > 0 || componentSystem !== "none-detected" ? "partial" : "none";

  const sorted = (s: Set<string>) => [...s].sort();
  return {
    schemaVersion: 1, layout, stack,
    tokens: { light: names.light.size, dark: names.dark.size, theme: names.theme.size, total: allTokens.size, names: { light: sorted(names.light), dark: sorted(names.dark), theme: sorted(names.theme) } },
    primitives, composites, pages, idioms: sorted(idioms),
    offSystem: { ...off, classNameCount, ratio: Number(ratio.toFixed(3)) },
    verdict,
    rules: [
      "Use only the building blocks and shared components listed here; a new building block is a design-system change.",
      "Colours, radius and spacing come from the theme tokens. No hex colours, no arbitrary [..] values beyond the ones the building blocks already use.",
      "A new page follows the layout of its nearest sibling page.",
    ],
  };
}

export function inventorySummary(inv: DesignInventory): string {
  const byKind = inv.pages.reduce<Record<string, number>>((a, p) => ({ ...a, [p.kind]: (a[p.kind] ?? 0) + 1 }), {});
  return [
    `stack: ${inv.stack.framework} / ${inv.stack.styling} / ${inv.stack.componentSystem}${inv.stack.componentSystemEvidence ? ` (${inv.stack.componentSystemEvidence})` : ""}`,
    `layout: source root ${inv.layout.sourceRoot || "(repo root)"}, building blocks in ${inv.layout.uiDir}, aliases ${inv.layout.aliases.map((a) => `${a.prefix}→${a.target || "(root)"}`).join(" ")}`,
    `tokens: ${inv.tokens.light} light, ${inv.tokens.dark} dark, ${inv.tokens.theme} in @theme`,
    `building blocks: ${inv.primitives.length} (${inv.primitives.filter((p) => p.uses > 0).length} used), shared components: ${inv.composites.length} (${inv.composites.filter((p) => p.uses > 0).length} used)`,
    `pages: ${inv.pages.length}${Object.keys(byKind).length ? ` (${Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(", ")})` : ""}`,
    `off-system styling: ${inv.offSystem.hexColors} hex, ${inv.offSystem.arbitraryValues} arbitrary, ${inv.offSystem.inlineStyle} inline style (${(inv.offSystem.ratio * 100).toFixed(1)}% of className sites)`,
    `verdict: ${inv.verdict}`,
  ].join("\n");
}
