// Benchmark runner.  npm run bench -- <calibrate|gates|all> [--home <dir>] [--no-save]
//   calibrate  back-test cost and wall-time predictions from the ledger (read-only)
//   gates      seeded-defect check of the gates
//   compare    read the ledger against the pinned external numbers (needs implement steps to say much)
//   evidence <estimate.json>  evidence pack for an estimate: each figure against measured and external data
//   external   print the pinned external reference tables (bench/external/snapshots)
// --home points at a copied ledger (sets FACTORY_HOME), e.g. the run from the other machine.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith("--")) ?? "all";
const flag = (n: string) => args.includes(`--${n}`);
const homeIdx = args.indexOf("--home");
if (homeIdx >= 0) {
  const home = args[homeIdx + 1];
  if (!home) { console.error("--home needs a directory"); process.exit(2); }
  process.env.FACTORY_HOME = home;
}
if (!["calibrate", "gates", "external", "compare", "evidence", "all"].includes(cmd)) { console.error(`Unknown command "${cmd}". Use calibrate, gates, external, compare, evidence or all.`); process.exit(2); }

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), "results");
const commit = (() => { try { return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "unknown"; } })();
const stamp = { date: new Date().toISOString(), commit };
const history: Record<string, unknown> = { ...stamp };
let failed = false;

if (cmd === "calibrate" || cmd === "all") {
  const { loadRecords } = await import("./calibration/records.js");
  const { backtest, formatBacktest } = await import("./calibration/backtest.js");
  const { records, runs, skipped } = loadRecords();
  const results = backtest(records);
  console.log("== Calibration ==\n" + formatBacktest(results, { runs, records: records.length }));
  if (skipped.length) console.log(`\nSkipped ${skipped.length} unreadable run(s):\n  ${skipped.join("\n  ")}`);
  history.calibration = { runs, records: records.length, results };
}

if (cmd === "compare" || cmd === "all") {
  const { loadRecords } = await import("./calibration/records.js");
  const { compareRounds, formatCompare } = await import("./external/compare.js");
  const { records } = loadRecords();
  const c = compareRounds(records);
  console.log((cmd === "all" ? "\n" : "") + formatCompare(c, records));
  history.compare = { rounds: c };
}

if (cmd === "evidence") {
  const file = args.filter((a) => !a.startsWith("--"))[1];
  if (!file) { console.error("evidence needs an estimate JSON, e.g. bench/external/fixtures/estimate-sample.json"); process.exit(2); }
  const { readFileSync } = await import("node:fs");
  const { loadRecords } = await import("./calibration/records.js");
  const { buildEvidence, formatEvidence } = await import("./external/evidence.js");
  const rows = buildEvidence(JSON.parse(readFileSync(file, "utf8")), loadRecords().records);
  console.log(formatEvidence(rows));
  history.evidence = { file, rows };
}

if (cmd === "gates" || cmd === "all") {
  const { runCases, formatGates, summarise, allGood } = await import("./gates/run.js");
  const results = runCases();
  console.log((cmd === "all" ? "\n" : "") + "== Gate efficacy ==\n" + formatGates(results));
  history.gates = { summary: summarise(results), cases: results };
  if (!allGood(results)) failed = true;
}

if (cmd === "external" || cmd === "all") {
  const { formatExternal } = await import("./external/priors.js");
  console.log((cmd === "all" ? "\n" : "") + formatExternal());
}

if (cmd !== "external" && !flag("no-save")) {
  mkdirSync(resultsDir, { recursive: true });
  appendFileSync(join(resultsDir, "history.jsonl"), JSON.stringify(history) + "\n");
  writeFileSync(join(resultsDir, "latest.json"), JSON.stringify(history, null, 2));
  console.log(`\nSaved to bench/results/ (history.jsonl, latest.json) at ${commit}`);
}
process.exitCode = failed ? 1 : 0;
