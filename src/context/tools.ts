// Locked-room repo tools served by the core (context-builder §2.2): read_file, search,
// repo_map over the snapshot only. No write, shell or network. Results are secret-scanned.
import { readFileSync } from "node:fs";
import { join, normalize } from "node:path";
import { isSecretPath } from "../gates/protected.js";
import { matchesAny } from "../util/glob.js";
import { buildRepoMap } from "./repomap.js";
import type { Redactor } from "./secrets.js";
import type { Snapshot } from "./snapshot.js";

export interface ToolDef {
  name: "read_file" | "search" | "repo_map";
  description: string;
  input_schema: Record<string, unknown>;
}

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "read_file",
    description: "Read a file from the repository at the run's base commit. Returns numbered lines. Use start/end for large files.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } },
      required: ["path"], additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Search file contents with a regular expression (case-insensitive). Optional glob limits the files, e.g. \"src/**/*.cs\". Returns up to 50 matches as path:line: text.",
    input_schema: {
      type: "object",
      properties: { pattern: { type: "string" }, glob: { type: "string" } },
      required: ["pattern"], additionalProperties: false,
    },
  },
  {
    name: "repo_map",
    description: "List code files with their main types and public members. Optional focus paths rank those folders first.",
    input_schema: {
      type: "object",
      properties: { focus: { type: "array", items: { type: "string" } } },
      additionalProperties: false,
    },
  },
];

const MAX_READ_LINES = 400;
const MAX_SEARCH_HITS = 50;

export class RepoTools {
  constructor(private readonly snap: Snapshot, private readonly redactor: Redactor, private readonly noGo: string[] = []) {}

  private safePath(p: string): string {
    const rel = normalize(p).replace(/^(\.\/)+/, "").replace(/^\/+/, "");
    if (rel.startsWith("..")) throw new Error("Path is outside the repository");
    if (isSecretPath(rel, this.noGo)) throw new Error("That file is excluded (secrets or no-go path)");
    if (!this.snap.files.includes(rel)) throw new Error(`No such file: ${rel}`);
    return rel;
  }

  call(name: string, input: Record<string, unknown>): string {
    try {
      const out = this.dispatch(name, input);
      return this.redactor.redact(out).text;
    } catch (e) {
      return `ERROR: ${(e as Error).message}`;
    }
  }

  private dispatch(name: string, input: Record<string, unknown>): string {
    switch (name) {
      case "read_file": return this.readFile(String(input.path ?? ""), input.start as number | undefined, input.end as number | undefined);
      case "search": return this.search(String(input.pattern ?? ""), input.glob as string | undefined);
      case "repo_map": return buildRepoMap(this.snap.root, this.snap.files, { budgetTokens: 3000, focus: input.focus as string[] | undefined }).map;
      default: throw new Error(`Unknown tool ${name}`);
    }
  }

  readFile(path: string, start = 1, end?: number): string {
    const rel = this.safePath(path);
    const lines = readFileSync(join(this.snap.root, rel), "utf8").split("\n");
    const s = Math.max(1, start);
    const e = Math.min(lines.length, end ?? s + MAX_READ_LINES - 1, s + MAX_READ_LINES - 1);
    const body = lines.slice(s - 1, e).map((l, i) => `${s + i}\t${l}`).join("\n");
    const more = e < lines.length ? `\n… (${lines.length} lines total; ask for start=${e + 1})` : "";
    return `${rel} lines ${s}-${e}\n${body}${more}`;
  }

  search(pattern: string, glob?: string): string {
    let re: RegExp;
    try { re = new RegExp(pattern, "i"); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
    const hits: string[] = [];
    for (const f of this.snap.files) {
      if (glob && !matchesAny(f, [glob])) continue;
      if (isSecretPath(f, this.noGo)) continue;
      let text: string;
      try { text = readFileSync(join(this.snap.root, f), "utf8"); } catch { continue; }
      if (text.includes("\u0000")) continue; // binary
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          hits.push(`${f}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
          if (hits.length >= MAX_SEARCH_HITS) return hits.join("\n") + "\n… more matches; narrow the pattern or glob";
        }
      }
    }
    return hits.length ? hits.join("\n") : "No matches";
  }
}

/** Evidence check (contracts: core checks quote == file[lines]). Whitespace-insensitive. */
export function checkEvidence(snap: Snapshot, ev: { path: string; lineStart: number; lineEnd: number; quote: string }): { ok: boolean; reason?: string } {
  const rel = normalize(ev.path).replace(/^(\.\/)+/, "");
  if (!snap.files.includes(rel)) return { ok: false, reason: `file ${rel} doesn't exist` };
  const lines = readFileSync(join(snap.root, rel), "utf8").split("\n");
  if (ev.lineStart < 1 || ev.lineEnd < ev.lineStart || ev.lineEnd > lines.length) return { ok: false, reason: `lines ${ev.lineStart}-${ev.lineEnd} are out of range` };
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  // allow a little slack: the quote must appear within ±2 lines of the stated range
  const window = lines.slice(Math.max(0, ev.lineStart - 3), Math.min(lines.length, ev.lineEnd + 2)).join("\n");
  return norm(window).includes(norm(ev.quote)) && norm(ev.quote).length > 0
    ? { ok: true }
    : { ok: false, reason: `quote not found at ${rel}:${ev.lineStart}-${ev.lineEnd}` };
}
