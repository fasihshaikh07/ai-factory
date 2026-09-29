// How a React/Next app is laid out: source root, import aliases, component folders and
// which files are pages. Shared by the inventory, the size classifier and the fidelity lint.
import { posix } from "node:path";
import type { FileSource } from "./source.js";

export type Framework = "next" | "vite-react" | "remix" | "react" | "unknown";
export type PageKind = "app-router" | "pages-router" | "feature-folder" | "file-route";

export interface Alias { prefix: string; target: string }

export interface AppLayout {
  framework: Framework;
  /** "" (repo root) or e.g. "src/" (always ends with "/" when set). */
  sourceRoot: string;
  /** Import aliases, longest prefix first, e.g. { prefix: "@/", target: "src/" }. */
  aliases: Alias[];
  /** Folder of the shared building blocks (primitives), e.g. "src/components/ui/". */
  uiDir: string;
  /** Folder of shared components, e.g. "src/components/". */
  componentsDir: string;
  /** Page conventions this app uses. */
  pageKinds: PageKind[];
  /** Where each setting came from, for the report. */
  notes: string[];
}

export interface PageInfo { kind: PageKind; route: string }

export interface PackageJson { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }

export function readJson<T>(text: string | undefined): T | undefined {
  if (text === undefined) return undefined;
  try { return JSON.parse(stripJsonComments(text)) as T; } catch { return undefined; }
}

/** tsconfig files are JSON with comments and trailing commas. */
export function stripJsonComments(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === "\\") { out += text[i + 1] ?? ""; i++; } else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; out += "\n"; continue; }
    if (c === "/" && text[i + 1] === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++; i++; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

export function depsOf(src: FileSource): Record<string, string> {
  const pkg = readJson<PackageJson>(src.read("package.json")) ?? {};
  return { ...pkg.dependencies, ...pkg.devDependencies };
}

export function frameworkOf(deps: Record<string, string>): Framework {
  if (deps.next) return "next";
  if (Object.keys(deps).some((d) => d.startsWith("@remix-run/") || d === "@react-router/dev")) return "remix";
  if (deps.vite && (deps.react || deps["@vitejs/plugin-react"] || deps["@vitejs/plugin-react-swc"])) return "vite-react";
  if (deps.react) return "react";
  return "unknown";
}

const norm = (p: string) => {
  const n = posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\//, "");
  return n === "." ? "" : n;
};
const dirOf = (p: string) => (p === "" ? "" : p.endsWith("/") ? p : `${p}/`);

/** Aliases from tsconfig/jsconfig `paths` (only "x/*" style entries). */
export function aliasesFrom(src: FileSource): { aliases: Alias[]; from?: string } {
  for (const f of ["tsconfig.json", "tsconfig.app.json", "jsconfig.json"]) {
    const cfg = readJson<{ compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }>(src.read(f));
    const paths = cfg?.compilerOptions?.paths;
    if (!paths) continue;
    const base = norm(cfg?.compilerOptions?.baseUrl ?? ".");
    const aliases: Alias[] = [];
    for (const [key, targets] of Object.entries(paths)) {
      const t = targets[0];
      if (!key.endsWith("/*") || !t?.endsWith("/*")) continue;
      aliases.push({ prefix: key.slice(0, -1), target: dirOf(norm(posix.join(base, t.slice(0, -2)))) });
    }
    if (aliases.length) return { aliases: aliases.sort((a, b) => b.prefix.length - a.prefix.length), from: f };
  }
  return { aliases: [] };
}

/** Resolve an import specifier to a repo path without extension, or undefined for packages. */
export function resolveImport(spec: string, importer: string, aliases: Alias[]): string | undefined {
  let p: string | undefined;
  if (spec.startsWith("./") || spec.startsWith("../")) p = norm(posix.join(posix.dirname(importer), spec));
  else {
    const a = aliases.find((x) => spec.startsWith(x.prefix));
    if (a) p = norm(a.target + spec.slice(a.prefix.length));
  }
  return p === undefined ? undefined : componentKey(p);
}

/** Path → key used to match imports: no extension, no trailing /index. */
export function componentKey(path: string): string {
  return path.replace(/\.(tsx|jsx|ts|js|mjs|cjs)$/, "").replace(/\/index$/, "");
}

/** Module specifiers in a piece of code: `from "x"`, `import "x"`, `import("x")`, both quote styles. */
export function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/\bfrom\s*(["'])([^"'\n]+)\1/g)) out.push(m[2]!);
  for (const m of code.matchAll(/\bimport\s*\(?\s*(["'])([^"'\n]+)\1/g)) out.push(m[2]!);
  return out;
}

export function detectLayout(src: FileSource, overrides: Partial<Pick<AppLayout, "sourceRoot" | "aliases" | "uiDir">> = {}): AppLayout {
  const files = src.list();
  const deps = depsOf(src);
  const framework = frameworkOf(deps);
  const notes: string[] = [];
  const has = (prefix: string) => files.some((f) => f.startsWith(prefix));

  let sourceRoot = overrides.sourceRoot;
  if (sourceRoot === undefined) {
    const rootApp = framework === "next" && (has("app/") || has("pages/"));
    sourceRoot = !rootApp && ["src/app/", "src/pages/", "src/components/", "src/features/", "src/routes/"].some(has) ? "src/" : "";
    notes.push(`source root: ${sourceRoot || "(repo root)"} (detected)`);
  } else notes.push(`source root: ${sourceRoot || "(repo root)"} (configured)`);
  sourceRoot = dirOf(norm(sourceRoot));

  let aliases = overrides.aliases;
  if (!aliases) {
    const found = aliasesFrom(src);
    aliases = found.aliases;
    if (found.from) notes.push(`import aliases from ${found.from}: ${aliases.map((a) => `${a.prefix} → ${a.target || "(root)"}`).join(", ")}`);
    if (!aliases.some((a) => a.prefix === "@/")) {
      aliases = [...aliases, { prefix: "@/", target: sourceRoot }].sort((a, b) => b.prefix.length - a.prefix.length);
      notes.push(`import alias @/ → ${sourceRoot || "(root)"} (default)`);
    }
  }

  let uiDir = overrides.uiDir;
  if (!uiDir) {
    const shadcn = readJson<{ aliases?: { ui?: string; components?: string } }>(src.read("components.json"));
    const fromCfg = shadcn?.aliases?.ui ?? (shadcn?.aliases?.components ? `${shadcn.aliases.components}/ui` : undefined);
    const resolved = fromCfg ? resolveImport(fromCfg, "components.json", aliases) : undefined;
    if (resolved !== undefined && has(dirOf(resolved))) { uiDir = dirOf(resolved); notes.push(`building blocks folder from components.json: ${uiDir}`); }
    else {
      const candidates = [...new Set(files.map((f) => /^(.*?components\/ui\/)/.exec(f)?.[1]).filter((x): x is string => !!x))].sort((a, b) => a.length - b.length);
      uiDir = candidates.find((c) => c === `${sourceRoot}components/ui/`) ?? candidates[0] ?? `${sourceRoot}components/ui/`;
    }
  }
  uiDir = dirOf(norm(uiDir));
  const componentsDir = uiDir.replace(/ui\/$/, "");

  const pageKinds: PageKind[] = [];
  if (framework === "next" || framework === "unknown") {
    if (has(`${sourceRoot}app/`)) pageKinds.push("app-router");
    if (has(`${sourceRoot}pages/`)) pageKinds.push("pages-router");
  }
  if (files.some((f) => new RegExp(`^${esc(sourceRoot)}features/[\\w-]+/index\\.(tsx|jsx)$`).test(f))) pageKinds.push("feature-folder");
  if ((deps["@tanstack/react-router"] || framework === "remix") && (has(`${sourceRoot}routes/`) || has("app/routes/"))) pageKinds.push("file-route");

  return { framework, sourceRoot, aliases, uiDir, componentsDir, pageKinds, notes };
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Special Next.js app-router files that are not screens of their own. */
export const NEXT_NON_PAGE = /^(layout|loading|error|global-error|not-found|template|head|default|route|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest|middleware|instrumentation)\.[jt]sx?$/;

/**
 * Is this path a page (a screen with its own URL)? `layout` may be partial (plan mode without a
 * repo): then both src/ and root conventions are accepted.
 */
export function pageOf(path: string, layout?: Pick<AppLayout, "sourceRoot" | "pageKinds" | "framework">): PageInfo | undefined {
  const roots = layout ? [layout.sourceRoot] : ["", "src/"];
  const kinds = layout?.pageKinds;
  const allow = (k: PageKind) => !kinds || kinds.includes(k) || (k === "app-router" && layout?.framework === "next") || (k === "pages-router" && layout?.framework === "next");
  for (const root of roots) {
    if (!path.startsWith(root)) continue;
    const rest = path.slice(root.length);
    // Next.js app router: app/**/page.tsx; private folders (_x) are not routes
    let m = /^app\/(?:(.*)\/)?page\.(tsx|jsx|ts|js|mdx|md)$/.exec(rest);
    if (m && allow("app-router")) {
      const segs = (m[1] ?? "").split("/").filter(Boolean);
      if (segs.some((s) => s.startsWith("_"))) return undefined;
      const route = "/" + segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@")).join("/");
      return { kind: "app-router", route };
    }
    // Next.js pages router: pages/**, not pages/api, not _app/_document/_error
    m = /^pages\/(.*)\.(tsx|jsx|ts|js|mdx|md)$/.exec(rest);
    if (m && allow("pages-router") && (!layout || layout.framework === "next" || layout.framework === "unknown")) {
      const segs = m[1]!.split("/");
      if (segs[0] === "api" || segs.some((s) => s.startsWith("_"))) return undefined;
      const route = "/" + segs.join("/").replace(/(^|\/)index$/, "");
      return { kind: "pages-router", route };
    }
    // feature folders: features/<name>/index.tsx
    m = /^features\/([\w-]+)\/index\.(tsx|jsx)$/.exec(rest);
    if (m && (!kinds || allow("feature-folder"))) return { kind: "feature-folder", route: `/${m[1]}` };
    // file routes (TanStack Router, Remix): routes/**; "-x" and "__root" are not routes
    m = /^(?:app\/)?routes\/(.*)\.(tsx|jsx)$/.exec(rest);
    if (m && kinds?.includes("file-route")) {
      const segs = m[1]!.split(/[/.]/);
      if (segs.some((s) => s.startsWith("-")) || /(^|\/)(__root|route)$/.test(m[1]!)) return undefined;
      return { kind: "file-route", route: "/" + m[1]!.replace(/(^|\/)index$/, "") };
    }
  }
  return undefined;
}
