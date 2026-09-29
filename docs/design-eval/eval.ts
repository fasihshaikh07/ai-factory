// Evaluation harness for the design toolkit (see results.md). Not part of the build.
// Usage: npx tsx docs/design-eval/eval.ts <evalDir> <originalToolsDir> [--table]
//   <evalDir> holds clones of shadcn-admin, taxonomy and skateshop (default branch checked out).
//   <originalToolsDir> holds the research scripts (pick-tier.mjs, design-inventory.mjs).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildInventory } from "../../src/design/inventory.js";
import { sizeFromGit, type Level } from "../../src/design/size.js";
import { diffFromGit, lintDiff, overall } from "../../src/design/fidelity.js";
import { dirSource, gitSource, gitSync } from "../../src/design/source.js";

const [evalDir, toolsDir] = process.argv.slice(2);
if (!evalDir || !toolsDir) throw new Error("usage: eval.ts <evalDir> <originalToolsDir>");
const here = new URL(".", import.meta.url).pathname;
const TIER: Record<string, Level> = { T0: "none", T1: "tweak", T2: "new-screen", T3: "design-system" };
const LEVELS: Level[] = ["none", "tweak", "new-screen", "design-system"];

const REPOS = [
  { name: "shadcn-admin", branch: "main", n: 80 },
  { name: "taxonomy", branch: "main", n: 0 },
  { name: "skateshop", branch: "main", n: 80 },
];

function original(repo: string, base: string, head: string, ctx: string): Level {
  const out = execFileSync("node", [join(toolsDir!, "pick-tier.mjs"), "--git", repo, base, head, ctx], { encoding: "utf8" });
  return TIER[(JSON.parse(out) as { tier: string }).tier]!;
}

type Row = { repo: string; commit: string; subject: string; original: Level; port: Level; why: string };
const rows: Row[] = [];
const pages: string[] = [];
for (const r of REPOS) {
  const repo = join(evalDir, r.name);
  const ctx = join(evalDir, `${r.name}.orig-ctx.json`);
  execFileSync("node", [join(toolsDir, "design-inventory.mjs"), repo, ctx], { encoding: "utf8" });
  const origPages = (JSON.parse(readFileSync(ctx, "utf8")) as { pages: unknown[] }).pages.length;
  const inv = buildInventory(dirSource(repo));
  const realNext = gitSync(repo, ["ls-files"]).split("\n").filter((f) => /(^|\/)app\/(.*\/)?page\.(tsx|jsx|ts|js|mdx)$/.test(f)).length;
  pages.push(`${r.name}: original ${origPages}, port ${inv.pages.length} (${[...new Set(inv.pages.map((p) => p.kind))].join(", ")}), page.* files in app/: ${realNext}; building blocks used ${inv.primitives.filter((p) => p.uses > 0).length}/${inv.primitives.length}, shared components used ${inv.composites.filter((p) => p.uses > 0).length}/${inv.composites.length}`);
  const revs = gitSync(repo, ["rev-list", "--no-merges", ...(r.n ? ["-n", String(r.n)] : []), r.branch]).trim().split("\n");
  for (const c of revs) {
    let parent: string;
    try { parent = gitSync(repo, ["rev-parse", "-q", "--verify", `${c}^`]).trim(); } catch { continue; }
    const p = sizeFromGit(repo, parent, c);
    rows.push({ repo: r.name, commit: c.slice(0, 10), subject: gitSync(repo, ["log", "-1", "--format=%s", c]).trim(), original: original(repo, parent, c, ctx), port: p.level, why: p.reasons.slice(0, 3).join(" | ") });
  }
}

if (process.argv.includes("--table")) {
  writeFileSync(join(evalDir, "table.tsv"), rows.map((x) => [x.repo, x.commit, x.original, x.port, x.subject, x.why].join("\t")).join("\n"));
}

const out: string[] = [];
out.push("## Pages", ...pages.map((p) => `- ${p}`), "");
out.push("## Distribution (all commits run)", "| repo | tool | no UI | screen tweak | new screen | design-system |", "|---|---|---|---|---|---|");
for (const r of REPOS) for (const tool of ["original", "port"] as const) {
  const xs = rows.filter((x) => x.repo === r.name);
  out.push(`| ${r.name} (${xs.length}) | ${tool} | ${LEVELS.map((l) => xs.filter((x) => x[tool] === l).length).join(" | ")} |`);
}

const labelsFile = join(here, "labels.csv");
if (existsSync(labelsFile)) {
  const labels = readFileSync(labelsFile, "utf8").trim().split("\n").slice(1).map((l) => l.split(","))
    .map(([repo, commit, label, stratum]) => ({ repo: repo!, commit: commit!, label: label as Level, stratum: stratum! }));
  const scored = labels.map((l) => ({ ...l, row: rows.find((x) => x.repo === l.repo && x.commit.startsWith(l.commit)) })).filter((l) => l.row);
  const acc = (xs: typeof scored, tool: "original" | "port") => `${xs.filter((x) => x.row![tool] === x.label).length}/${xs.length}`;
  out.push("", `## Accuracy on ${scored.length} hand-labelled commits`, "| set | original | port |", "|---|---|---|");
  for (const [name, xs] of [["all", scored], ...["taxonomy", "skateshop"].map((r) => [r, scored.filter((x) => x.repo === r)] as const), ...[...new Set(scored.map((x) => x.stratum))].map((s) => [`stratum: ${s}`, scored.filter((x) => x.stratum === s)] as const)] as const) {
    out.push(`| ${name} | ${acc(xs, "original")} | ${acc(xs, "port")} |`);
  }
  for (const tool of ["original", "port"] as const) {
    out.push("", `### Confusion: ${tool} (rows = label, columns = tool)`, `| label \\ tool | ${LEVELS.join(" | ")} |`, "|---|---|---|---|---|");
    for (const l of LEVELS) out.push(`| ${l} | ${LEVELS.map((t) => scored.filter((x) => x.label === l && x.row![tool] === t).length).join(" | ")} |`);
  }
  out.push("", "### Port mistakes", ...scored.filter((x) => x.row!.port !== x.label).map((x) => `- ${x.repo} ${x.commit} "${x.row!.subject.slice(0, 60)}": label ${x.label}, port ${x.row!.port} (${x.row!.why.slice(0, 160)})`));
  const missing = labels.filter((l) => !scored.includes(l as never) && !rows.some((x) => x.repo === l.repo && x.commit.startsWith(l.commit)));
  if (missing.length) out.push("", `Labels not found in the run: ${missing.map((m) => m.commit).join(", ")}`);
}
// drift test: a local "drift" branch with a new building block, hex colours, arbitrary values
// and a double-quoted import of an unknown component
out.push("", "## Drift lint (default branch → drift)");
for (const name of ["taxonomy", "skateshop"]) {
  const repo = join(evalDir, name);
  try {
    const results = lintDiff(buildInventory(gitSource(repo, "main")), diffFromGit(repo, "main", "drift"));
    out.push(`- ${name}: ${results.map((x) => `${x.check.replace("lint: ", "")} ${x.status}`).join(", ")} → ${overall(results)}`);
  } catch (e) { out.push(`- ${name}: no drift branch (${(e as Error).message.slice(0, 60)})`); }
}
console.log(out.join("\n"));
