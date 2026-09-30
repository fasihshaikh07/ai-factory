// A run's preview (contracts: RunPreview): read-only files under <ledger dir>/preview, served to the
// page's sandboxed iframe. Every path is checked: no "..", no absolute or encoded escapes, no
// symlink anywhere on the way, and only plain web file types.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { extname, join, sep } from "node:path";
import { RunPreview } from "../contracts/index.js";
import type { Ledger } from "../ledger/ledger.js";

export const PREVIEW_DIR = "preview";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8",
};

/** The preview's description, or why there is none (missing, or a manifest that doesn't parse). */
export function readPreview(ledger: Ledger): { preview: RunPreview } | { none: string } {
  const f = join(ledger.dir, PREVIEW_DIR, "preview.json");
  if (!existsSync(f)) return { none: "Clickable mocks appear here once the estimate module produces them." };
  try {
    const p = RunPreview.parse(JSON.parse(readFileSync(f, "utf8")));
    const bad = [p.site?.entry, ...(p.site?.screens ?? []).map((s) => s.path), ...p.images.flatMap((i) => [i.file, i.before])]
      .filter((x): x is string => x !== undefined).find((x) => safeRelative(x.split(/[?#]/)[0]!) === undefined);
    if (bad) return { none: `The preview names a file outside its folder (${bad}); it isn't shown.` };
    return { preview: p };
  } catch (e) {
    return { none: `The preview description is invalid: ${(e as Error).message.split("\n")[0]}` };
  }
}

/**
 * A request path (still URL-encoded) → a clean relative path, or undefined when it could escape.
 * Refuses "..", ".", empty segments, backslashes, NUL, absolute paths and hidden files; decodes once
 * and refuses anything still encoded (double encoding).
 */
export function safeRelative(raw: string): string | undefined {
  let p: string;
  try { p = decodeURIComponent(raw); } catch { return undefined; }
  if (!p || p.includes("\0") || p.includes("\\") || p.includes("%") || p.startsWith("/")) return undefined;
  const parts = p.split("/");
  if (parts.some((s) => s === "" || s === "." || s === ".." || s.startsWith("."))) return undefined;
  return parts.join("/");
}

/** Read one preview file: undefined unless it's a regular file inside preview/ reached without symlinks. */
export function previewFile(ledger: Ledger, raw: string): { body: Buffer; type: string } | undefined {
  const rel = safeRelative(raw);
  if (!rel) return undefined;
  const type = TYPES[extname(rel).toLowerCase()];
  if (!type) return undefined;
  const root = join(ledger.dir, PREVIEW_DIR);
  if (!existsSync(root) || lstatSync(root).isSymbolicLink()) return undefined;
  let cur = root;
  for (const part of rel.split("/")) {
    cur = join(cur, part);
    if (!existsSync(cur)) return undefined;
    if (lstatSync(cur).isSymbolicLink()) return undefined;
  }
  if (!lstatSync(cur).isFile()) return undefined;
  const realRoot = realpathSync(root);
  if (!realpathSync(cur).startsWith(realRoot + sep)) return undefined;
  return { body: readFileSync(cur), type };
}
