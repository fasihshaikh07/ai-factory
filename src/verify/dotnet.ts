// .NET stack pack producer (verify-runner §2.2): copy → restore → build (no network)
// → test in the Postgres container's namespace → stop everything → read results.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { BuildRun, TestResult, TestRun, VerifyStage } from "../contracts/index.js";
import { fillTemplate, type ProjectConfig } from "../config/project.js";
import { secret } from "../config/env.js";
import { hardenedEnv } from "../ledger/git.js";
import { sha256 } from "../util/hash.js";
import { factoryHome } from "../util/paths.js";
import { FEED_PROXY_URL, FEEDS_NET } from "../runners/netinfra.js";
import { type ContainerRuntime, type ContainerSpec, stopAndRemove } from "./runtime.js";
import { parseTrx } from "./trx.js";
import { buildTestRun, type Expectations, markFlaky, needsProbe, rerunCandidates } from "./validate.js";

export interface ProduceInput {
  runId: string;
  key: string;                 // step key, for container labels
  repo: string;                // host repo (only git archive reads it)
  commit: string;              // the gated commit
  stage: VerifyStage;
  exp: Expectations;
  project: ProjectConfig;
  rt: ContainerRuntime;
  /** Logged before start (run-manager §2.10). */
  onContainer?: (id: string, role: ContainerSpec["role"]) => Promise<void>;
  onRemoved?: (id: string) => Promise<void>;
  /** For author-tests-on-base: only run these tests. */
  onlyTests?: string[];
  /** tests that failed in the baseline: never re-run as possibly flaky */
  knownFailures?: ReadonlySet<string>;
  /** Per-run package folder, kept between producer runs (restore is the slow part). */
  packagesDir?: string;
  /** A raw `dotnet test --filter` expression (used to find tests by method name). */
  filterExpr?: string;
  /** Only restore packages into packagesDir (for the coding container); no build or tests. */
  restoreOnly?: boolean;
  /** Accept: boot the app in the db's namespace and send these probes before the tests run. */
  accept?: { probes: Probe[] };
  /** For the run trace: one call per finished phase. */
  onPhase?: (phase: string, msg: string, data?: Record<string, unknown>) => void;
}

export interface Probe { acId: string; method: string; path: string; body?: string; expectStatus: number }

export interface AcceptResult {
  boot: { attempted: boolean; ok: boolean; project?: string; firstStatus?: number; ms?: number; note?: string; logTail: string };
  probes: { acId: string; method: string; path: string; requestBody?: string; status: number; expectStatus: number; responseBody: string }[];
}

export interface ProduceOutput {
  testRun: TestRun;
  build: BuildRun;
  reports: { name: string; content: string }[];
  logs: { restore: string; build: string; test: string };
  accept?: AcceptResult;
}

/** Repo-relative paths of files matching `want`; the lab copy has no .git, so walk the folders. */
function findFiles(src: string, want: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string, rel: string, depth: number) => {
    if (depth > 5) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (["bin", "obj", "node_modules", ".git"].includes(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r, depth + 1);
      else if (want(e.name)) found.push(r);
    }
  };
  walk(src, "", 0);
  return found.sort();
}

/** The web project to boot: the configured one, else the first csproj using Sdk.Web. */
export function findWebProject(src: string, configured?: string): string | undefined {
  if (configured) return configured;
  return findFiles(src, (n) => n.endsWith(".csproj")).find((f) => /Sdk="Microsoft\.NET\.Sdk\.Web"/.test(readFileSync(join(src, f), "utf8")) && !/test/i.test(f));
}

const isSolution = (n: string) => n.endsWith(".sln") || n.endsWith(".slnx");
const isProject = (n: string) => /\.(cs|fs|vb)proj$/.test(n);

/**
 * What restore/build/test point at: the configured solution; nothing when the repo root holds a
 * solution or project (dotnet finds it); else the shallowest solution, else the only project.
 */
export function findBuildTarget(src: string, configured?: string): string | undefined {
  if (configured) return configured;
  if (readdirSync(src).some((n) => isSolution(n) || isProject(n))) return undefined;
  const depth = (f: string) => f.split("/").length;
  const slns = findFiles(src, isSolution);
  if (slns.length) {
    const top = slns.filter((f) => depth(f) === Math.min(...slns.map(depth)));
    if (top.length === 1) return top[0];
    throw new Error(`Several solutions and none at the repo root (${top.join(", ")}). Set dotnet.solution in the project config.`);
  }
  const projs = findFiles(src, isProject);
  if (projs.length <= 1) return projs[0];
  throw new Error(`No solution file and several projects (${projs.slice(0, 5).join(", ")}${projs.length > 5 ? ", …" : ""}). Add a .sln to the repo or set dotnet.solution in the project config.`);
}

/** "body\nSTATUS" from curl -w → { body, status } */
export function splitCurl(out: string): { body: string; status: number } {
  const i = out.lastIndexOf("\n");
  const status = Number((i >= 0 ? out.slice(i + 1) : out).trim());
  return { body: i >= 0 ? out.slice(0, i) : "", status: Number.isFinite(status) ? status : 0 };
}

const BASE_ENV = {
  HOME: "/tmp", DOTNET_CLI_HOME: "/tmp", DOTNET_NOLOGO: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", NUGET_PACKAGES: "/nuget", MSBUILDDISABLENODEREUSE: "1",
};

function hostUser(): string {
  return `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
}

/** git archive <commit> into a fresh folder: no .git, no leftovers (verify-runner §2.2 step 1). */
export function copyTree(repo: string, commit: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  const tar = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "archive", "--format=tar", commit], {
    cwd: repo, env: hardenedEnv(), maxBuffer: 2 * 1024 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", dest], { input: tar });
}

/** `path(line,col): error CS1234: message [project]` */
export function parseBuildErrors(log: string): BuildRun["errors"] {
  const out: BuildRun["errors"] = [];
  const seen = new Set<string>();
  for (const line of log.split("\n")) {
    const m = /^\s*(.+?)\((\d+),\d+\): error ([A-Z]+\d+): (.+?)(?: \[.*\])?\s*$/.exec(line);
    if (!m) continue;
    const file = m[1]!.replace(/^\/src\//, "");
    const k = `${file}:${m[2]}:${m[3]}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ file, line: Number(m[2]), code: m[3]!, msg: m[4]! });
  }
  return out;
}

/** Test ID → dotnet test filter term: strip "<project>::" and theory args. */
export function filterFor(ids: string[]): string {
  return ids.map((id) => `FullyQualifiedName=${id.replace(/^[^:]*::/, "").replace(/\(.*$/, "")}`).join("|");
}

export async function produceDotnetTests(inp: ProduceInput): Promise<ProduceOutput> {
  const { rt, project } = inp;
  const n = `${Date.now()}-${randomBytes(3).toString("hex")}`;
  const work = join(factoryHome(), "tmp", inp.runId, n);
  const src = join(work, "src"), nuget = inp.packagesDir ?? join(work, "nuget"), resBuild = join(work, "results-build"), resTest = join(work, "results-test");
  for (const d of [src, nuget, resBuild, resTest]) mkdirSync(d, { recursive: true });
  const live = new Set<string>();
  const logs = { restore: "", build: "", test: "" };
  let sln: string[] = [];

  const launch = async (spec: Omit<ContainerSpec, "labels" | "user"> & { user?: string }): Promise<string> => {
    const id = await rt.create({ user: hostUser(), ...spec, labels: { run: inp.runId, key: inp.key } });
    live.add(id);
    await inp.onContainer?.(id, spec.role);
    await rt.start(id);
    return id;
  };
  const finish = async (id: string) => {
    await stopAndRemove(rt, id);
    live.delete(id);
    await inp.onRemoved?.(id);
  };

  try {
    const t0 = Date.now();
    const phase = (name: string, msg: string, data?: Record<string, unknown>) => inp.onPhase?.(name, msg, data);
    const secs = (from: number) => `${((Date.now() - from) / 1000).toFixed(0)}s`;
    copyTree(inp.repo, inp.commit, src);
    const target = findBuildTarget(src, project.dotnet.solution);
    if (target) sln = [target];
    phase("copy", `lab: copied ${inp.commit.slice(0, 10)} (${secs(t0)})`);
    const tRestore = Date.now();
    const toolVersions: Record<string, string> = { sdkImage: await rt.imageDigest(project.dotnet.sdkImage) };

    // restore: only package feeds, through the feed proxy (host allowlist; URL-prefix TLS proxy not built yet)
    const r = await launch({
      role: "restore", image: project.dotnet.sdkImage, network: FEEDS_NET, workdir: "/src",
      env: { ...BASE_ENV, HTTPS_PROXY: FEED_PROXY_URL, HTTP_PROXY: FEED_PROXY_URL, NUGET_CERT_REVOCATION_MODE: "offline" },
      mounts: [{ src, dst: "/src" }, { src: nuget, dst: "/nuget" }], cmd: ["dotnet", "restore", ...sln],
    });
    const rCode = await rt.wait(r, project.dotnet.buildTimeoutSec * 1000);
    phase("restore", `lab: restore ${rCode === 0 ? "ok" : `FAILED (exit ${rCode ?? "timeout"})`} (${secs(tRestore)})`, rCode === 0 ? undefined : { logTail: (await rt.logs(r)).split("\n").slice(-40).join("\n") });
    logs.restore = await rt.logs(r);
    await finish(r);
    if (inp.restoreOnly) {
      const build: BuildRun = { kind: "build", ok: rCode === 0, errors: rCode === 0 ? [] : [{ file: "", line: 0, code: "RESTORE", msg: `dotnet restore failed (exit ${rCode ?? "timeout"})` }] };
      const testRun = buildTestRun({ treeSha: inp.commit, stage: inp.stage, toolVersions, exp: inp.exp, raw: { reports: [], results: [], discovered: [], exitCode: rCode ?? 124, buildFailed: rCode !== 0 }, probeOk: () => true });
      return { testRun, build, reports: [], logs };
    }

    // build, no network
    let build: BuildRun = { kind: "build", ok: false, errors: [] };
    if (rCode === 0) {
      const b = await launch({
        role: "producer", image: project.dotnet.sdkImage, network: "none", workdir: "/src", env: BASE_ENV,
        mounts: [{ src, dst: "/src" }, { src: nuget, dst: "/nuget", ro: true }],
        cmd: ["dotnet", "build", ...sln, "--no-restore", "-nologo", "-p:TreatWarningsAsErrors=false"],
      });
      const tBuild = Date.now();
      const bCode = await rt.wait(b, project.dotnet.buildTimeoutSec * 1000);
      phase("build", `lab: build ${bCode === 0 ? "ok" : `FAILED (exit ${bCode ?? "timeout"})`} (${secs(tBuild)})`);
      await rt.stop(b); // stop before read
      logs.build = await rt.logs(b);
      await finish(b);
      build = { kind: "build", ok: bCode === 0, errors: parseBuildErrors(logs.build) };
    } else {
      build.errors.push({ file: "", line: 0, code: "RESTORE", msg: `dotnet restore failed (exit ${rCode ?? "timeout"})` });
    }

    if (!build.ok) {
      const testRun = buildTestRun({
        treeSha: inp.commit, stage: inp.stage, toolVersions, exp: inp.exp,
        raw: { reports: [], results: [], discovered: [], exitCode: 1, buildFailed: true }, probeOk: () => true,
      });
      return { testRun, build, reports: [], logs };
    }

    // db: loopback only
    let dbId: string | undefined;
    const db = project.database;
    const dbVars = {
      DB_HOST: "127.0.0.1", DB_PORT: "5432", DB_NAME: db?.name ?? "app_test", DB_USER: db?.user ?? "factory",
      DB_PASSWORD: (db?.passwordEnv ? secret(db.passwordEnv) : undefined) ?? randomBytes(12).toString("hex"),
    };
    if (db?.passwordEnv && !secret(db.passwordEnv)) throw new Error(`${db.passwordEnv} is missing in ~/.factory/.env`);
    if (db) {
      toolVersions.dbImage = await rt.imageDigest(db.image);
      // The image's superuser gets a random password nobody sees; tests log in as a CREATEDB role.
      dbId = await launch({
        role: "db", image: db.image, network: "none", user: "",
        env: { POSTGRES_USER: "factory_admin", POSTGRES_PASSWORD: randomBytes(16).toString("hex"), POSTGRES_DB: "postgres" },
        capAdd: ["CHOWN", "SETUID", "SETGID", "FOWNER", "DAC_OVERRIDE"], mounts: [], cmd: [],
      });
      const tDb = Date.now();
      await waitForPg(rt, dbId);
      phase("db", `lab: test Postgres ready (${secs(tDb)})`);
      const ident = dbVars.DB_USER.replace(/"/g, "");
      const pw = dbVars.DB_PASSWORD.replace(/'/g, "''");
      // separate -c flags: CREATE DATABASE can't run inside the single transaction one -c makes
      const r = await rt.exec(dbId, ["psql", "-v", "ON_ERROR_STOP=1", "-U", "factory_admin", "-d", "postgres",
        "-c", `CREATE ROLE "${ident}" LOGIN CREATEDB NOSUPERUSER PASSWORD '${pw}'`,
        "-c", `CREATE DATABASE "${dbVars.DB_NAME.replace(/"/g, "")}" OWNER "${ident}"`]);
      if (r.code !== 0) throw new Error(`Couldn't create the test database login: ${r.stderr.split(dbVars.DB_PASSWORD).join("«SECRET»").slice(0, 300)}`);
    }
    const dbEnv = project.database ? fillTemplate(project.database.producerEnv, dbVars) : {};

    const runTests = async (filter: string | undefined, resultsDir: string) => {
      const started = Date.now();
      const t = await launch({
        role: "producer", image: project.dotnet.sdkImage, network: dbId ? `container:${dbId}` : "none", workdir: "/src",
        env: { ...BASE_ENV, ...dbEnv },
        mounts: [{ src, dst: "/src" }, { src: nuget, dst: "/nuget", ro: true }, { src: resultsDir, dst: "/results" }],
        cmd: [
          "dotnet", "test", ...sln, "--no-build", "--no-restore", "--nologo",
          "--logger", "trx;LogFilePrefix=r", "--results-directory", "/results",
          "--blame-hang-timeout", `${Math.max(60, Math.round(project.dotnet.testTimeoutSec / 3))}s`,
          ...(filter ? ["--filter", filter] : []),
          ...(project.dotnet.runnerArgs.length ? ["--", ...project.dotnet.runnerArgs] : []),
        ],
      });
      const code = await rt.wait(t, project.dotnet.testTimeoutSec * 1000);
      await rt.stop(t); // every process in the room is dead before we read
      const log = await rt.logs(t);
      await finish(t);
      const reports = readdirSync(resultsDir).filter((f) => f.endsWith(".trx")).map((f) => {
        const p = join(resultsDir, f);
        const content = readFileSync(p, "utf8");
        let parsed = true, results: TestResult[] = [];
        try { results = parseTrx(content, f.replace(/\.trx$/, "")).results; } catch { parsed = false; }
        return { name: f, content, sha: sha256(content), parsed, writtenAfterStart: statSync(p).mtimeMs >= started - 1000, results };
      });
      return { code: code ?? 124, log, reports };
    };

    let accept: AcceptResult | undefined;
    if (inp.accept) {
      accept = await bootAndProbe(inp, src, nuget, dbId, dbEnv, launch, finish);
      phase("app", accept.boot.attempted ? `lab: app ${accept.boot.ok ? `started, first answer HTTP ${accept.boot.firstStatus}` : `DIDN'T START: ${accept.boot.note}`} (${((accept.boot.ms ?? 0) / 1000).toFixed(0)}s)` : `lab: app not booted: ${accept.boot.note}`,
        accept.boot.ok ? undefined : { logTail: accept.boot.logTail });
      for (const p of accept.probes) phase("probe", `lab: probe ${p.method} ${p.path} → ${p.status} (expected ${p.expectStatus})`);
    }

    const filter = inp.filterExpr ?? (inp.onlyTests?.length ? filterFor(inp.onlyTests) : undefined);
    const tTests = Date.now();
    const first = await runTests(filter, resTest);
    {
      const rs = first.reports.flatMap((r) => r.results);
      phase("tests", `lab: tests ran: ${rs.length} (${rs.filter((x) => x.outcome === "passed").length} passed, ${rs.filter((x) => x.outcome === "failed").length} failed), exit ${first.code} (${secs(tTests)})`,
        first.reports.length ? undefined : { logTail: first.log.split("\n").slice(-40).join("\n") });
    }
    logs.test = first.log;
    let results = first.reports.flatMap((r) => r.results);

    let probe = true;
    if (dbId && needsProbe(results)) probe = (await rt.exec(dbId, ["pg_isready", "-h", "127.0.0.1"])).code === 0;

    const again = rerunCandidates(results, inp.exp, inp.knownFailures);
    if (again.length && again.length <= 20 && probe) {
      const dir = join(work, "results-rerun");
      mkdirSync(dir, { recursive: true });
      phase("rerun", `lab: re-running ${again.length} failed non-locked test(s) once`);
      const second = await runTests(filterFor(again), dir);
      results = markFlaky(results, second.reports.flatMap((r) => r.results));
    }
    if (dbId) await finish(dbId);

    const expected = [...inp.exp.expectPass, ...inp.exp.expectFail.map((e) => e.id)];
    const testRun = buildTestRun({
      treeSha: inp.commit, stage: inp.stage, toolVersions, exp: inp.exp,
      raw: {
        reports: first.reports.map((r) => ({ sha: r.sha, parsed: r.parsed, writtenAfterStart: r.writtenAfterStart })),
        // discovered = the IDs we require; `dotnet test --list-tests` prints display names, not IDs
        results, discovered: expected, exitCode: first.code,
      },
      probeOk: () => probe,
    });
    return { testRun, build, reports: first.reports.map((r) => ({ name: r.name, content: r.content })), logs, accept };
  } finally {
    for (const id of live) await stopAndRemove(rt, id).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Accept (verify-runner §2.8, minimal): run the built app in the db's loopback-only namespace, wait
 * for any HTTP answer, send each locked probe, record request and response. The app is stopped
 * before anything is read back.
 */
async function bootAndProbe(
  inp: ProduceInput, src: string, nuget: string, dbId: string | undefined, dbEnv: Record<string, string>,
  launch: (spec: Omit<ContainerSpec, "labels" | "user"> & { user?: string }) => Promise<string>,
  finish: (id: string) => Promise<void>,
): Promise<AcceptResult> {
  const { rt, project } = inp;
  const cfg = project.accept;
  const none = (note: string): AcceptResult => ({ boot: { attempted: false, ok: false, note, logTail: "" }, probes: [] });
  if (!cfg.bootApp) return none("booting the app is turned off for this project");
  const web = findWebProject(src, cfg.project);
  if (!web) return none("no web project found (no csproj uses Sdk.Web)");
  const base = `http://127.0.0.1:${cfg.port}`;
  const started = Date.now();
  const app = await launch({
    role: "app", image: project.dotnet.sdkImage, network: dbId ? `container:${dbId}` : "none", workdir: "/src",
    env: { ...BASE_ENV, ...dbEnv, ASPNETCORE_ENVIRONMENT: "Development", ASPNETCORE_URLS: base, DOTNET_ENVIRONMENT: "Development", ...cfg.env },
    mounts: [{ src, dst: "/src" }, { src: nuget, dst: "/nuget", ro: true }],
    cmd: ["dotnet", "run", "--no-build", "--no-launch-profile", "--project", web, "--urls", base],
  });
  let firstStatus = 0;
  let crashed = false;
  const until = started + cfg.readyTimeoutSec * 1000;
  while (Date.now() < until) {
    if (!(await rt.isRunning(app))) { crashed = true; break; }
    const r = await rt.exec(app, ["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", `${base}${cfg.readyPath}`]);
    firstStatus = Number(r.stdout.trim()) || 0;
    if (firstStatus > 0) break;
    await new Promise((res) => setTimeout(res, 1000));
  }
  const ms = Date.now() - started;
  const probes: AcceptResult["probes"] = [];
  if (firstStatus > 0) {
    for (const p of inp.accept!.probes) {
      const args = ["curl", "-s", "-X", p.method.toUpperCase(), "-H", "Content-Type: application/json", "-w", "\n%{http_code}"];
      if (p.body !== undefined) args.push("--data-binary", p.body);
      args.push(`${base}${p.path.startsWith("/") ? p.path : `/${p.path}`}`);
      const r = splitCurl((await rt.exec(app, args)).stdout);
      probes.push({ acId: p.acId, method: p.method.toUpperCase(), path: p.path, requestBody: p.body, status: r.status, expectStatus: p.expectStatus, responseBody: r.body.slice(0, 20_000) });
    }
  }
  await rt.stop(app); // stop before reading its log
  const logTail = (await rt.logs(app)).split("\n").slice(-60).join("\n");
  await finish(app);
  return {
    boot: {
      attempted: true, ok: firstStatus > 0, project: web, firstStatus, ms, logTail,
      note: firstStatus > 0 ? undefined : crashed
        ? `the app exited during startup after ${Math.round(ms / 1000)}s: ${firstError(logTail)}`
        : `no HTTP answer on ${cfg.readyPath} within ${cfg.readyTimeoutSec}s`,
    },
    probes,
  };
}

/** The first exception line of a .NET log, for the park message. */
export function firstError(log: string): string {
  const line = log.split("\n").find((l) => /(Exception|Error)[^a-z]*[:(]/.test(l) && !/^\s+at /.test(l));
  return (line ?? log.split("\n").filter(Boolean).slice(-1)[0] ?? "").trim().slice(0, 300);
}

async function waitForPg(rt: ContainerRuntime, id: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await rt.exec(id, ["pg_isready", "-h", "127.0.0.1"])).code === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Postgres didn't become ready in 60 s");
}
