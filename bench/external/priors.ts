// Loads the pinned external snapshots (bench/external/snapshots/*.json) and prints them as reference tables.
// The snapshots are derived offline by bench/external/derive/*.py from the sources in sources.json; nothing is fetched here.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "snapshots");

export function load<T>(name: string): T | undefined {
  const f = join(dir, `${name}.json`);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : undefined;
}

type Row = Record<string, string | number | null>;
export interface Source { name: string; url: string; revision: string; license: string; retrieved: string }
interface Metr { source: Source; suites: Record<string, { byHumanDuration: Row[] }>; caveats: string[] }
interface Aidev { source: Source; prsUsed: number; prsMerged: number; overallBySize: Row[]; caveats: string[] }
export interface Openhands { source: Source; overall: Row; byOutcome: Row[]; byPatchSize: Row[]; caveats: string[] }

const cell = (v: string | number | null | undefined) => (v === null || v === undefined ? "-" : String(v));
function table(rows: Row[], cols: [key: string, head: string][]): string[] {
  const w = cols.map(([k, h]) => Math.max(h.length, ...rows.map((r) => cell(r[k]).length)));
  const line = (vals: string[]) => vals.map((v, i) => v.padStart(w[i]!)).join("  ");
  return ["  " + line(cols.map(([, h]) => h)), ...rows.map((r) => "  " + line(cols.map(([k]) => cell(r[k]))))];
}
const head = (s: Source) => [`${s.name}`, `  ${s.url} @ ${s.revision.slice(0, 10)} · ${s.license.split(/\.\s/)[0]} · retrieved ${s.retrieved}`];

export function formatExternal(): string {
  const out: string[] = [];
  const metr = load<Metr>("metr");
  const aidev = load<Aidev>("aidev");
  const oh = load<Openhands>("openhands");
  if (!metr && !aidev && !oh) return "No external snapshots yet. Run bench/external/fetch.sh, then the derive scripts (see bench/external/README.md).";

  if (metr) {
    out.push("== Agent reliability and effort by how long a human takes (METR, suite 1.1) ==", ...head(metr.source));
    out.push(...table(metr.suites["1-1"]!.byHumanDuration, [["bucket", "human time"], ["tasks", "tasks"], ["runs", "runs"], ["success", "success"], ["tokens_median", "tokens p50"], ["tokens_p90", "tokens p90"]]));
    out.push(...metr.caveats.slice(0, 2).map((c) => `  note: ${c}`), "");
  }
  if (aidev) {
    out.push(`== Agent PRs: merge and review time by size (AIDev, ${aidev.prsUsed} PRs) ==`, ...head(aidev.source));
    out.push(...table(aidev.overallBySize, [["band", "PR size"], ["prs", "PRs"], ["mergeRate", "merged"], ["humanReviewRate", "reviewed"], ["firstReviewHoursMedian", "1st review h p50"], ["mergeHoursMedianReviewed", "merge h p50 (reviewed)"], ["mergeHoursP90", "merge h p90 (all)"]]));
    out.push(...aidev.caveats.slice(1, 3).map((c) => `  note: ${c}`), "");
  }
  if (oh) {
    out.push(`== Tool-call rounds per task (SWE-rebench OpenHands, ${cell(oh.overall.n)} tasks) ==`, ...head(oh.source));
    out.push(...table(oh.byOutcome, [["resolved", "resolved"], ["n", "tasks"], ["roundsP10", "rounds p10"], ["roundsP50", "rounds p50"], ["roundsP90", "rounds p90"]]));
    out.push(`  note: ${oh.caveats[0]}`, "");
  }
  return out.join("\n");
}
