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
  /** Per-run package folder, kept between producer runs (restore is the slow part). */
  packagesDir?: string;
}

export interface ProduceOutput {
  testRun: TestRun;
  build: BuildRun;
  reports: { name: string; content: string }[];
  logs: { restore: string; build: string; test: string };
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
  const sln = project.dotnet.solution ? [project.dotnet.solution] : [];

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
    copyTree(inp.repo, inp.commit, src);
    const toolVersions: Record<string, string> = { sdkImage: await rt.imageDigest(project.dotnet.sdkImage) };

    // restore: only package feeds, through the feed proxy (host allowlist; URL-prefix TLS proxy not built yet)
    const r = await launch({
      role: "restore", image: project.dotnet.sdkImage, network: FEEDS_NET, workdir: "/src",
      env: { ...BASE_ENV, HTTPS_PROXY: FEED_PROXY_URL, HTTP_PROXY: FEED_PROXY_URL, NUGET_CERT_REVOCATION_MODE: "offline" },
      mounts: [{ src, dst: "/src" }, { src: nuget, dst: "/nuget" }], cmd: ["dotnet", "restore", ...sln],
    });
    const rCode = await rt.wait(r, project.dotnet.buildTimeoutSec * 1000);
    logs.restore = await rt.logs(r);
    await finish(r);

    // build, no network
    let build: BuildRun = { kind: "build", ok: false, errors: [] };
    if (rCode === 0) {
      const b = await launch({
        role: "producer", image: project.dotnet.sdkImage, network: "none", workdir: "/src", env: BASE_ENV,
        mounts: [{ src, dst: "/src" }, { src: nuget, dst: "/nuget", ro: true }],
        cmd: ["dotnet", "build", ...sln, "--no-restore", "-nologo", "-p:TreatWarningsAsErrors=false"],
      });
      const bCode = await rt.wait(b, project.dotnet.buildTimeoutSec * 1000);
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
      await waitForPg(rt, dbId);
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

    const filter = inp.onlyTests?.length ? filterFor(inp.onlyTests) : undefined;
    const first = await runTests(filter, resTest);
    logs.test = first.log;
    let results = first.reports.flatMap((r) => r.results);

    let probe = true;
    if (dbId && needsProbe(results)) probe = (await rt.exec(dbId, ["pg_isready", "-h", "127.0.0.1"])).code === 0;

    const again = rerunCandidates(results, inp.exp);
    if (again.length && again.length <= 20 && probe) {
      const dir = join(work, "results-rerun");
      mkdirSync(dir, { recursive: true });
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
    return { testRun, build, reports: first.reports.map((r) => ({ name: r.name, content: r.content })), logs };
  } finally {
    for (const id of live) await stopAndRemove(rt, id).catch(() => undefined);
    rmSync(work, { recursive: true, force: true });
  }
}

async function waitForPg(rt: ContainerRuntime, id: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if ((await rt.exec(id, ["pg_isready", "-h", "127.0.0.1"])).code === 0) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("Postgres didn't become ready in 60 s");
}
