#!/usr/bin/env node
// factory CLI (run-manager §2.8). Decisions (approve/reject/...) work only on a terminal.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { hasSecret } from "../config/env.js";
import { loadProject, projectPath } from "../config/project.js";
import { verifyEvidence } from "../gates/engine.js";
import "../gates/predicates.js";
import "../design/gates.js";
import { registerDesignCommands } from "../design/cli.js";
import { assertTty, decide, DecisionError } from "../ledger/human.js";
import { HUMAN_WRITER, Ledger } from "../ledger/ledger.js";
import { replay, statusLabel } from "../ledger/state.js";
import { createRun, execute } from "../stages/executor.js";
import { describeSources, gatherRequest } from "../sources/request.js";
import { checkRoutes } from "../stages/routing.js";
import { findRuntimeBinary } from "../verify/runtime.js";
import { factoryHome } from "../util/paths.js";

const log = (m: string): void => { process.stdout.write(`${m}\n`); };

function openRun(runId: string): Ledger {
  if (!Ledger.exists(runId)) {
    const matches = Ledger.listRuns().filter((r) => r.includes(runId));
    if (matches.length === 1) return Ledger.open(matches[0]!);
    throw new Error(matches.length ? `"${runId}" matches several runs: ${matches.join(", ")}` : `No run ${runId}`);
  }
  return Ledger.open(runId);
}

async function runAndReport(runId: string): Promise<void> {
  const r = await execute(runId, log);
  log(`\n${r.status}: ${r.message}`);
}

const program = new Command();
program.name("factory").description("AI Factory: turns a request into a verified PR").version("0.1.0");

program.command("start")
  .argument("[prompt]", "what you want changed, in plain words")
  .requiredOption("--project <name>", "project config in ~/.factory/projects/<name>.yaml")
  .option("--file <path>", "the request as a Markdown or text file")
  .option("--jira <key>", "the request as a Jira ticket (ABC-123 or its link)")
  .option("--max-cost <dollars>", "a lower spend limit for this run (it can only lower the normal limit)")
  .description("create a run from a prompt, a file or a Jira ticket (any one, or several) and execute until a card, a park, or delivery")
  .action(async (prompt: string | undefined, o: { project: string; maxCost?: string; file?: string; jira?: string }) => {
    const project = loadProject(o.project);
    const problems = checkRoutes(project);
    if (problems.length) throw new Error(`Setup problems:\n- ${problems.join("\n- ")}`);
    // everything is read before a run exists: a bad file or ticket costs nothing
    const req = await gatherRequest({ prompt, file: o.file, jira: o.jira });
    const runId = await createRun(req.text, o.project, userInfo().username, {
      ...(o.maxCost !== undefined ? { maxCostUsd: Number(o.maxCost) } : {}),
      sources: req.sources,
    });
    log(`run ${runId} (request from ${describeSources(req.sources)})`);
    log(`run ${runId}`);
    await runAndReport(runId);
  });

program.command("resume").argument("<run>").description("continue a run").action(async (run: string) => {
  await runAndReport(openRun(run).runId);
});

program.command("status").argument("[run]").description("state, current step, cost, open card").action(async (run?: string) => {
  const runs = run ? [openRun(run).runId] : Ledger.listRuns().slice(-10);
  if (!runs.length) return log("No runs yet.");
  for (const id of runs) {
    const s = replay(Ledger.open(id).events());
    const steps = [...s.steps.values()];
    const current = s.inFlight?.step ?? steps.filter((x) => x.status !== "completed").pop()?.step ?? steps[steps.length - 1]?.step ?? "-";
    log(`${id}  ${statusLabel(s.status).padEnd(10)} step ${current.padEnd(18)} $${s.costUsd.toFixed(2)}${s.openCard ? `  card: ${s.openCard.kind} ${s.openCard.artifactSha.slice(0, 8)}` : ""}${s.parkedReason ? `\n    parked: ${s.parkedReason}` : ""}`);
    if (run) {
      const { lastActivity, fmtElapsed } = await import("../util/trace.js");
      const last = lastActivity(Ledger.open(id).dir);
      if (last) {
        const ago = Date.now() - Date.parse(last.ts);
        const busy = s.status === "running" || !!s.inFlight;
        log(`    now: ${last.step ?? "run"}${last.attempt ? ` attempt ${last.attempt}` : ""} · ${last.msg} · ${fmtElapsed(ago).slice(1)} ago${busy && ago > 10 * 60_000 ? `  ⚠ no activity for ${Math.round(ago / 60_000)} min (see factory logs ${id} --follow)` : ""}`);
      }
      for (const x of steps) log(`    ${x.status.padEnd(11)} ${x.step}  (attempts ${x.attempts})`);
    }
  }
});

program.command("show-card").argument("<run>").option("--pr", "show the PR text").description("print the open card").action((run: string, o: { pr?: boolean }) => {
  const l = openRun(run);
  if (o.pr) return log(l.readCard(`pr-${l.runId}`));
  const s = replay(l.events());
  if (!s.openCard) return log(s.parkedReason ? `No open card. Parked: ${s.parkedReason}` : "No open card.");
  log(l.readCard(s.openCard.cardId));
});

for (const d of ["approve", "reject"] as const) {
  program.command(d).argument("<run>").argument("<hash>", "first characters of the card hash")
    .option("--note <text>", "your risk note (approve)")
    .option("--reason <text>", "why (reject)")
    .option("--reject <reason>", "reject instead, with this reason (approve only)")
    .description(d === "approve"
      ? "approve the open card, or --reject \"<reason>\" to send the spec and plan back with your reason (terminal only)"
      : "reject the open card with --reason; the spec and plan are revised and you get a new card (terminal only)")
    .action(async (run: string, hash: string, o: { note?: string; reason?: string; reject?: string }) => {
      assertTty();
      const l = openRun(run);
      const decision = d === "approve" && o.reject !== undefined ? "reject" : d;
      const data = decision === "approve" ? { note: o.note ?? "" } : { reason: o.reject ?? o.reason ?? "" };
      const r = await decide(l, { decision, hashPrefix: hash, data });
      if (r.kind === "repeat") return log("Already recorded.");
      log(decision === "approve" ? "Approved." : "Rejected. Revising the spec and plan with your reason…");
      await runAndReport(l.runId);
    });
}

program.command("answer").argument("<run>").argument("<hash>", "first characters of the card hash")
  .argument("<answers...>", 'Q-1=A Q-2="your own words"')
  .description("answer the open question card (terminal only)")
  .action(async (run: string, hash: string, pairs: string[]) => {
    assertTty();
    const answers: Record<string, string> = {};
    for (const p of pairs) {
      const m = /^(Q-\d+)=(.+)$/s.exec(p);
      if (!m) throw new DecisionError(`Can't read "${p}". Use Q-1=A or Q-1="words".`);
      answers[m[1]!] = m[2]!;
    }
    const l = openRun(run);
    const r = await decide(l, { decision: "answer", hashPrefix: hash, data: { answers } });
    log(r.kind === "repeat" ? "Already recorded." : "Answers recorded; unanswered questions use the recommended option.");
    if (r.kind === "recorded") await runAndReport(l.runId);
  });

program.command("waive-cap").argument("<run>").argument("<hash>", "first characters of the limit card's hash")
  .option("--cost <dollars>", "new cost limit for this run, in USD")
  .option("--minutes <n>", "new active-time limit, in minutes")
  .option("--attempts <n>", "extra attempts per step (the retry ladder starts again)")
  .description("accept going past a limit (cost, time or attempts) and continue; without options uses the card's suggestion (terminal only)")
  .action(async (run: string, hash: string, o: { cost?: string; minutes?: string; attempts?: string }) => {
    assertTty();
    const num = (v: string | undefined, name: string) => {
      if (v === undefined) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new DecisionError(`--${name} must be a positive number`);
      return n;
    };
    const l = openRun(run);
    const card = replay(l.events()).openCard as ({ kind: string; proposal?: Record<string, number> } | undefined);
    if (card?.kind !== "cap") throw new DecisionError("The open card isn't a limit card.");
    const data: Record<string, number> = { ...(card.proposal ?? {}) };
    const cost = num(o.cost, "cost"), minutes = num(o.minutes, "minutes"), attempts = num(o.attempts, "attempts");
    if (cost !== undefined) data.costUsd = cost;
    if (minutes !== undefined) data.wallMinutes = minutes;
    if (attempts !== undefined) data.extraAttempts = Math.round(attempts);
    const r = await decide(l, { decision: "waive-cap", hashPrefix: hash, data });
    if (r.kind === "repeat") return log("Already recorded.");
    log(`New limits: ${Object.entries(data).map(([k, v]) => `${k} ${v}`).join(", ")}. Continuing…`);
    await runAndReport(l.runId);
  });

for (const c of ["pause", "stop"] as const) {
  program.command(c).argument("<run>").description(`${c} a run at the next step boundary`).action(async (run: string) => {
    const l = openRun(run);
    await l.append({ type: c === "pause" ? "run.pause-requested" : "run.stop-requested" }, HUMAN_WRITER);
    log(`${c} requested; it takes effect at the next step boundary.`);
  });
}

program.command("steer").argument("<run>").argument("<file>", "a text file describing the change").description("record a requirement change (applied at the next step boundary)")
  .action(async (run: string, file: string) => {
    assertTty();
    const l = openRun(run);
    const sha = l.putArtifact(readFileSync(file, "utf8"));
    await l.append({ type: "change.received", data: { sha, by: userInfo().username } }, HUMAN_WRITER);
    log("Change recorded. Note: applying changes mid-run (re-spec, re-plan) isn't built yet; the run will park when it sees it.");
  });

program.command("baseline").requiredOption("--project <name>")
  .description("build and test the untouched repo in the test lab (no model calls)")
  .action(async (o: { project: string }) => {
    const project = loadProject(o.project);
    const { resolveRef } = await import("../ledger/git.js");
    const { produceDotnetTests } = await import("../verify/dotnet.js");
    const { DockerCli } = await import("../verify/runtime.js");
    const { ensureEgress, feedHostsFrom } = await import("../runners/netinfra.js");
    const { DEFAULT_POLICY } = await import("../gates/policy.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const commit = await resolveRef(project.repo, project.baseBranch);
    const rt = new DockerCli();
    log(`baseline for ${project.project} @ ${commit.slice(0, 8)}: starting proxies`);
    await ensureEgress(rt, feedHostsFrom(DEFAULT_POLICY.registryAllowlist));
    const pk = join(factoryHome(), "tmp", `baseline-${project.project}`, "nuget");
    mkdirSync(pk, { recursive: true });
    const started = Date.now();
    const out = await produceDotnetTests({
      runId: `baseline-${project.project}`, key: "baseline", repo: project.repo, commit, stage: "baseline",
      exp: { expectPass: [], expectFail: [], compareToBaseline: [] }, project, rt, packagesDir: pk,
      onContainer: async (id, role) => log(`  container ${role} ${id.slice(0, 12)}`),
      onPhase: (_p, msg) => log(`  ${msg}`),
    });
    const secs = Math.round((Date.now() - started) / 1000);
    if (!out.build.ok) {
      log(`build FAILED after ${secs}s`);
      for (const e of out.build.errors.slice(0, 15)) log(`  ${e.file}:${e.line} ${e.code} ${e.msg}`);
      log(`--- restore log tail ---\n${out.logs.restore.split("\n").slice(-25).join("\n")}`);
      log(`--- build log tail ---\n${out.logs.build.split("\n").slice(-25).join("\n")}`);
      process.exitCode = 1;
      return;
    }
    const r = out.testRun.results;
    const failed = r.filter((x) => x.outcome === "failed");
    log(`done in ${secs}s: ${r.length} tests, ${r.filter((x) => x.outcome === "passed").length} passed, ${failed.length} failed, ${r.filter((x) => x.outcome === "skipped").length} skipped; exit ${out.testRun.exitCode}; valid=${out.testRun.valid}`);
    for (const f of failed.slice(0, 10)) log(`  FAIL ${f.id} [${f.failureKind}] ${(f.message ?? "").split("\n")[0]!.slice(0, 160)}`);
    if (!r.length) log(`--- test log tail ---\n${out.logs.test.split("\n").slice(-30).join("\n")}`);
    const dir = join(factoryHome(), "repos", project.project);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `baseline-${commit}.json`), JSON.stringify(out.testRun));
    log(`saved; discover will reuse it for this commit`);
  });

program.command("logs").argument("<run>")
  .option("-f, --follow", "keep printing new lines while the run works (Ctrl+C to stop)")
  .option("--step <key>", "only lines of one step, e.g. plan or implement/TASK-1")
  .option("--full", "also print what the AI answered and each tool call's result, for every model turn")
  .description("the run's trace: every step, model turn, tool call, container phase and gate, with times")
  .action(async (run: string, o: { follow?: boolean; step?: string; full?: boolean }) => {
    const { readTrace, formatLine } = await import("../util/trace.js");
    const l = openRun(run);
    const show = (e: import("../util/trace.js").TraceEvent) => {
      if (o.step && !(e.step === o.step || e.step?.startsWith(`${o.step}/`))) return;
      log(formatLine(e));
      const sha = (e.data as { turnSha?: string; logSha?: string } | undefined);
      const blob = sha?.turnSha ?? sha?.logSha;
      if (o.full && blob && l.hasArtifact(blob)) log(l.getArtifact(blob).toString("utf8").split("\n").map((x) => `      | ${x}`).join("\n"));
    };
    let seen = 0;
    const flush = () => { const all = readTrace(l.dir); for (const e of all.slice(seen)) show(e); seen = all.length; };
    flush();
    if (!seen) log("No trace yet for this run (runs started before tracing existed have none).");
    if (o.follow) {
      await new Promise<void>((resolve) => {
        const t = setInterval(() => {
          flush();
          const st = replay(l.events()).status;
          if (typeof st === "object" || st === "delivered" || st === "parked" || st === "waiting" || st === "paused") { clearInterval(t); flush(); resolve(); }
        }, 1000);
      });
    }
  });

program.command("report").argument("[run]")
  .option("--all", "compare steps across all runs")
  .description("step scorecard: first-time pass, retries and why, cost, time, tokens, gates, what you changed")
  .action(async (run: string | undefined, o: { all?: boolean }) => {
    const { formatAll, formatRun, scoreRun } = await import("../report.js");
    if (o.all || !run) {
      const runs = Ledger.listRuns().map((id) => { try { return scoreRun(Ledger.open(id)); } catch { return undefined; } }).filter((r): r is NonNullable<typeof r> => !!r);
      return log(runs.length ? formatAll(runs) : "No runs yet.");
    }
    log(formatRun(scoreRun(openRun(run))));
  });

program.command("verify-evidence").argument("<run>").description("re-check every recorded gate decision").action((run: string) => {
  const checks = verifyEvidence(openRun(run));
  for (const c of checks) log(`${c.ok ? "ok  " : "FAIL"} #${c.seq} ${c.gateId}${c.reason ? `: ${c.reason}` : ""}`);
  log(checks.every((c) => c.ok) ? `All ${checks.length} decisions re-check.` : "Some decisions don't re-check.");
  if (!checks.every((c) => c.ok)) process.exitCode = 1;
});

program.command("init").argument("<repo>", "a local repo path (Windows paths like /mnt/c/... are fine) or a git URL")
  .option("--branch <name>", "base branch (default: the repo's current branch)")
  .option("--name <name>", "project name (default: from the folder name)")
  .option("--force", "overwrite an existing project config")
  .description("set up a project: copy the repo into Linux if needed, detect its settings, write the config")
  .action(async (repoArg: string, o: { branch?: string; name?: string; force?: boolean }) => {
    const { execFileSync } = await import("node:child_process");
    const { appendFileSync, mkdirSync, writeFileSync, chmodSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const { detectDotnet, envVarFor, projectYaml, slugName } = await import("../config/detect.js");
    const { loadFactoryEnv, _resetEnvCache } = await import("../config/env.js");
    const isUrl = /^(https?:\/\/|git@|ssh:\/\/)/.test(repoArg);
    const src = isUrl ? repoArg : (await import("node:path")).resolve(repoArg);
    const name = o.name ?? slugName(isUrl ? repoArg.replace(/\.git$/, "").split(/[/:]/).pop()! : src);
    let repo = src;
    // repos must live inside Linux; copy anything on a Windows drive (or a URL) into ~/code/<name>
    if (isUrl || /^\/mnt\/[a-z]\//i.test(src)) {
      repo = join(homedir(), "code", name);
      if (existsSync(repo)) log(`Using the existing copy at ${repo}`);
      else {
        mkdirSync(join(homedir(), "code"), { recursive: true });
        const branchArgs = o.branch ? ["--branch", o.branch] : [];
        log(`Copying the repo to ${repo} (inside Linux, where the factory works)…`);
        execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "safe.directory=*", "clone", ...(isUrl ? [] : ["--no-hardlinks"]), ...branchArgs, src, repo], { stdio: "inherit" });
      }
    }
    if (!existsSync(join(repo, ".git"))) throw new Error(`${repo} isn't a git repository`);
    const branch = o.branch ?? execFileSync("git", ["-c", "safe.directory=*", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
    const d = detectDotnet(repo);
    d.name = name;
    if (!d.targetFrameworks.length) throw new Error("No .NET projects found. The POC supports .NET repos (other stacks come later).");
    log(`\nProject ${name}`);
    log(`  repo        ${repo} (branch ${branch})`);
    log(`  solution    ${d.solution ?? "(none; dotnet will pick)"}`);
    log(`  .NET        ${d.targetFrameworks.join(", ")} → ${d.sdkImage}`);
    log(`  database    ${d.usesPostgres ? `Postgres${d.testDb ? `; tests log in as "${d.testDb.user}" to ${d.testDb.database} (${d.testDb.file})` : ""}` : "none detected"}`);
    if (d.frontendDirs.length) log(`  hidden      ${d.frontendDirs.join(", ")} (frontend folders the AI won't see)`);
    if (d.refusals.length) log(`\n  ⚠ Not supported yet: ${d.refusals.join("; ")}`);

    const file = projectPath(name);
    if (existsSync(file) && !o.force) throw new Error(`${file} already exists (use --force to overwrite)`);
    mkdirSync(join(factoryHome(), "projects"), { recursive: true, mode: 0o700 });
    writeFileSync(file, projectYaml(d, repo, branch));
    // the tests' own hardcoded DB password goes to ~/.factory/.env (never printed, never in the YAML)
    if (d.testDb) {
      const key = envVarFor(name, "TEST_DB_PASSWORD");
      if (!loadFactoryEnv()[key]) {
        const envFile = join(factoryHome(), ".env");
        appendFileSync(envFile, `${key}=${d.testDb.password}\n`, { mode: 0o600 });
        chmodSync(envFile, 0o600);
        _resetEnvCache();
        log(`  saved the tests' database password to ~/.factory/.env as ${key}`);
      }
    }
    log(`\nWrote ${file}\nNext: factory baseline --project ${name}   (builds and tests the untouched repo; no AI, no cost)`);
  });

program.command("mcp").description("run the MCP server (for Claude Code: start runs, read status and cards; no decisions)")
  .action(async () => {
    const { startMcpServer } = await import("../mcp/server.js");
    await startMcpServer();
  });

program.command("smoke").option("--project <name>", "also check models this project overrides")
  .option("--all", "re-check everything, even checks that passed before")
  .description("cheap real check of every paid connection (a few cents): each model, the key proxy, the coding agent")
  .action(async (o: { project?: string; all?: boolean }) => {
    const { runSmoke } = await import("../smoke.js");
    const { defaultProvider } = await import("../runners/api.js");
    const { DockerCli } = await import("../verify/runtime.js");
    const checks = await runSmoke({ provider: defaultProvider, rt: new DockerCli(), project: o.project ? loadProject(o.project) : undefined, log, all: o.all });
    const total = checks.reduce((n, c) => n + c.costUsd, 0);
    const ok = checks.length > 0 && checks.every((c) => c.ok);
    log(`\n${ok ? "All checks passed" : "Stopped at the first failure; fix it before a real run"}. Spent about $${total.toFixed(4)}.`);
    if (!ok) process.exitCode = 1;
  });

program.command("doctor").description("check this machine and the setup").action(async () => {
  const ok = (b: boolean, m: string, fix?: string) => log(`${b ? "ok  " : "MISSING"} ${m}${!b && fix ? `\n      → ${fix}` : ""}`);
  ok(Number(process.versions.node.split(".")[0]) >= 22, `Node ${process.version}`, "install Node 22 with nvm");
  const wsl = process.platform === "linux" && /microsoft/i.test(existsSync("/proc/version") ? readFileSync("/proc/version", "utf8") : "");
  if (process.platform === "darwin") ok(true, "macOS");
  else ok(process.platform === "linux" && !process.cwd().startsWith("/mnt/"), wsl ? "running inside WSL (Ubuntu), not on a Windows drive" : "running on Linux", "on Windows, use the Ubuntu terminal (install.ps1 sets it up)");
  let rt = "";
  try { rt = findRuntimeBinary(); } catch (e) { rt = ""; ok(false, "container runtime", (e as Error).message); }
  if (rt) {
    ok(true, `container runtime: ${rt}`);
    const { apiProxyState } = await import("../runners/netinfra.js");
    const { DockerCli } = await import("../verify/runtime.js");
    const st = await apiProxyState(new DockerCli(rt));
    log(st === "current" ? "ok   key proxy is up to date with your keys"
      : `note key proxy ${st === "outdated" ? "has old settings (e.g. from before you added a key)" : "isn't running"}; it restarts automatically on the next run or smoke test`);
  }
  ok(existsSync(join(factoryHome(), ".env")), "~/.factory/.env exists", "create it yourself with your API keys (never paste keys into chat)");
  ok(hasSecret("ANTHROPIC_API_KEY"), "ANTHROPIC_API_KEY set in ~/.factory/.env");
  log(`${hasSecret("OPENAI_API_KEY") ? "ok  " : "note"} OPENAI_API_KEY ${hasSecret("OPENAI_API_KEY") ? "set" : "not set: critic and review will use Claude (single family)"}`);
  const { jiraConfigured } = await import("../sources/jira.js");
  log(jiraConfigured() ? "ok   Jira set up (factory start --jira ABC-123)" : "note Jira not set up (optional): add JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN to ~/.factory/.env to use --jira");
  if (hasSecret("OPENAI_API_KEY")) {
    const { DEFAULT_ROUTES } = await import("../stages/routing.js");
    const gpt = [...new Set(Object.values(DEFAULT_ROUTES).map((r) => r.model).filter((m) => /^gpt|^o\d/.test(m)))];
    for (const name of existsSync(join(factoryHome(), "projects")) ? readdirSync(join(factoryHome(), "projects")).filter((f) => f.endsWith(".yaml")) : []) {
      const p = loadProject(name.replace(/\.yaml$/, ""));
      const missing = gpt.filter((m) => !p.prices[m]);
      if (missing.length) log(`note ${p.project}: no price set for ${missing.join(", ")}; cost is estimated high ($10/$50 per million). Add "prices:" to its config.`);
    }
  }
  const projects = existsSync(join(factoryHome(), "projects")) ? readdirSync(join(factoryHome(), "projects")).filter((f) => f.endsWith(".yaml")) : [];
  ok(projects.length > 0, `projects: ${projects.join(", ").replace(/\.yaml/g, "") || "none"}`, "add one with: factory init <path-to-repo-or-git-url>");
});

// design toolkit (src/design): factory design inventory|size|lint|brief
registerDesignCommands(program);

program.parseAsync().catch((e: Error) => {
  if (e instanceof DecisionError) process.stderr.write(`${e.message}\n`);
  else process.stderr.write(`error: ${e.message}\n`);
  process.exitCode = 1;
});
