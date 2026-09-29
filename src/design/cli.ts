// `factory design ...`: run the design toolkit by hand on any local repo.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { cleanBrief } from "./brief.js";
import { diffFromGit, lintDiff, overall } from "./fidelity.js";
import { buildInventory, inventorySummary } from "./inventory.js";
import { detectLayout } from "./layout.js";
import { plannedChanges, sizeChange, sizeFromGit, type SizeInput, type SizeResult } from "./size.js";
import { dirSource, gitSource, type FileSource } from "./source.js";

const out = (m: string): void => { process.stdout.write(`${m}\n`); };

function source(repo: string, ref?: string): FileSource {
  return ref ? gitSource(repo, ref) : dirSource(repo);
}

function printSize(r: SizeResult, json?: boolean): void {
  if (json) return out(JSON.stringify(r, null, 2));
  out(`UI size: ${r.name} (${r.mode} mode, ${r.uiFiles} UI file(s))`);
  out(`Design work: ${r.work}`);
  for (const w of r.reasons) out(`  - ${w}`);
}

export function registerDesignCommands(program: Command): void {
  const design = program.command("design").description("design toolkit: inventory, UI change size, fidelity lint, brief cleaner (no model, no network)");

  design.command("inventory").argument("<repo>", "path to a React or Next.js repo")
    .option("--ref <commit>", "read the files at this commit instead of the working folder")
    .option("--source-root <dir>", "source root, e.g. src (default: detected)")
    .option("--ui-dir <dir>", "building-blocks folder, e.g. src/components/ui (default: detected)")
    .option("--json", "print the full inventory as JSON")
    .option("--out <file>", "also write the JSON to a file")
    .description("scan the repo's design system: stack, tokens, building blocks, pages")
    .action((repo: string, o: { ref?: string; sourceRoot?: string; uiDir?: string; json?: boolean; out?: string }) => {
      const inv = buildInventory(source(resolve(repo), o.ref), { ...(o.sourceRoot !== undefined ? { sourceRoot: o.sourceRoot } : {}), ...(o.uiDir ? { uiDir: o.uiDir } : {}) });
      const json = JSON.stringify(inv, null, 2);
      if (o.out) writeFileSync(o.out, json);
      out(o.json ? json : `${inventorySummary(inv)}\n${inv.layout.notes.map((n) => `  (${n})`).join("\n")}`);
    });

  design.command("size")
    .option("--plan <file>", "JSON: { files: [{ path, change: add|modify|delete }] } or a plan with tasks[].fileScope")
    .option("--git <refs...>", "two commits: <base> <head>")
    .option("--repo <path>", "the repo (default: current folder)", ".")
    .option("--nav-raises", "count navigation edits as design-system changes (the original rule)")
    .option("--json", "print JSON")
    .description("size of a UI change: no UI / screen tweak / new screen / design-system change")
    .action((o: { plan?: string; git?: string[]; repo: string; navRaises?: boolean; json?: boolean }) => {
      const repo = resolve(o.repo);
      if (!!o.plan === !!o.git) throw new Error("Give either --plan <file> or --git <base> <head>");
      if (o.git) {
        if (o.git.length !== 2) throw new Error("--git takes two commits: <base> <head>");
        return printSize(sizeFromGit(repo, o.git[0]!, o.git[1]!, { navRaises: !!o.navRaises }), o.json);
      }
      const plan = JSON.parse(readFileSync(o.plan!, "utf8")) as SizeInput & { tasks?: { fileScope: string[] }[] };
      const src = dirSource(repo);
      const hasPkg = src.read("package.json") !== undefined;
      const layout = hasPkg ? detectLayout(src) : undefined;
      const input: SizeInput = plan.tasks ? { files: plannedChanges(plan.tasks.flatMap((t) => t.fileScope), src, layout) } : plan;
      printSize(sizeChange(input, { ...(layout ? { layout } : {}), navRaises: !!o.navRaises }), o.json);
    });

  design.command("lint")
    .requiredOption("--git <refs...>", "two commits: <approved-or-base> <head>")
    .option("--repo <path>", "the repo (default: current folder)", ".")
    .option("--json", "print JSON")
    .description("fidelity lint of a change: tokens only, existing components only, no new building blocks")
    .action((o: { git: string[]; repo: string; json?: boolean }) => {
      if (o.git.length !== 2) throw new Error("--git takes two commits: <base> <head>");
      const repo = resolve(o.repo);
      const inv = buildInventory(gitSource(repo, o.git[0]!));
      const results = lintDiff(inv, diffFromGit(repo, o.git[0]!, o.git[1]!));
      if (o.json) out(JSON.stringify({ overall: overall(results), results }, null, 2));
      else {
        for (const r of results) {
          out(`${r.status.padEnd(9)} ${r.check.padEnd(34)} ${r.detail}`);
          for (const i of r.items?.slice(0, 8) ?? []) out(`          - ${i}`);
        }
        out(`overall: ${overall(results)}`);
      }
      if (overall(results) !== "pass") process.exitCode = 1;
    });

  design.command("brief").argument("<extract.json>", "an untrusted design extract (Figma export, screenshot reading, brand guide)")
    .option("--repo <path>", "the repo, for its component inventory", ".")
    .option("--brand-font <name...>", "brand fonts to allow")
    .description("clean an untrusted design extract into typed fields; print what was dropped")
    .action((file: string, o: { repo: string; brandFont?: string[] }) => {
      const inv = buildInventory(dirSource(resolve(o.repo)));
      const r = cleanBrief(JSON.parse(readFileSync(file, "utf8")), inv, { brandFonts: o.brandFont ?? [] });
      out(JSON.stringify(r, null, 2));
    });
}
