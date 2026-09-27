// A small ranked repo map (Aider-style, simplified): files with their top-level symbols,
// capped by tokens. Regex-based for the POC; tree-sitter can replace the extractor later.
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { estimateTokens } from "./tokens.js";

const CODE_EXT = new Set([".cs", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cts", ".mts"]);

/** Top-level types and public members for C#; exports for TS/JS. */
export function extractSymbols(path: string, text: string): string[] {
  const ext = extname(path);
  const out: string[] = [];
  if (ext === ".cs") {
    for (const m of text.matchAll(/^\s*(?:\[[^\]]*\]\s*)*(?:public|internal)\s+(?:static\s+|sealed\s+|abstract\s+|partial\s+|record\s+)*(class|interface|record|enum|struct)\s+(\w+)/gm)) {
      out.push(`${m[1]} ${m[2]}`);
    }
    for (const m of text.matchAll(/^\s*public\s+(?:static\s+|async\s+|virtual\s+|override\s+)*([\w<>\[\],.? ]+?)\s+(\w+)\s*\(([^)]*)\)/gm)) {
      if (["class", "interface", "record", "new"].includes(m[1]!.trim())) continue;
      out.push(`  ${m[1]!.trim()} ${m[2]}(${m[3]!.replace(/\s+/g, " ").trim().slice(0, 80)})`);
    }
    for (const m of text.matchAll(/^\s*\[(Http(?:Get|Post|Put|Delete|Patch))(?:\("([^"]*)"\))?\]/gm)) out.push(`  [${m[1]}${m[2] ? ` ${m[2]}` : ""}]`);
  } else if (CODE_EXT.has(ext)) {
    for (const m of text.matchAll(/^export\s+(?:default\s+)?(?:async\s+)?(function|class|const|interface|type|enum)\s+(\w+)/gm)) out.push(`${m[1]} ${m[2]}`);
  }
  return out.slice(0, 40);
}

/** Rank: files under touched folders first, then source over tests, then shorter paths. */
export function buildRepoMap(root: string, files: string[], opts: { budgetTokens: number; focus?: string[] }): { map: string; truncated: boolean } {
  const focus = opts.focus ?? [];
  const code = files.filter((f) => CODE_EXT.has(extname(f)));
  const score = (f: string) => {
    let s = 0;
    for (const x of focus) if (f.startsWith(x.replace(/[^/]+$/, ""))) s -= 100;
    if (/test/i.test(f)) s += 10;
    return s + f.split("/").length;
  };
  const ranked = [...code].sort((a, b) => score(a) - score(b) || a.localeCompare(b));
  const lines: string[] = [];
  let tokens = 0, truncated = false;
  for (const f of ranked) {
    let text = "";
    try { text = readFileSync(join(root, f), "utf8"); } catch { continue; }
    const block = [f, ...extractSymbols(f, text).map((s) => `  ${s}`)].join("\n");
    const t = estimateTokens(block);
    if (tokens + t > opts.budgetTokens) { truncated = true; break; }
    lines.push(block);
    tokens += t;
  }
  const rest = code.length - lines.length;
  return { map: lines.join("\n") + (rest > 0 ? `\n… ${rest} more code files (use search)` : ""), truncated };
}
