import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ProjectConfig } from "../config/project.js";
import { filterFor, parseBuildErrors, produceDotnetTests } from "./dotnet.js";
import type { ContainerRuntime, ContainerSpec } from "./runtime.js";
import { classifyFailure, parseTrx } from "./trx.js";
import { buildTestRun, classify, rerunCandidates, validate } from "./validate.js";
import { trx } from "./testutil.js";

beforeEach(() => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-verify-"));
});

describe("TRX", () => {
  it("parses results into stable IDs with failure kinds", () => {
    const p = parseTrx(trx([
      { name: "Checkout_Works", outcome: "Passed" },
      { name: "Checkout_Rejects", outcome: "Failed", message: "Assert.Equal() Failure: Values differ", stack: "   at Shop.Tests.CheckoutTests.Checkout_Rejects() in /src/tests/CheckoutTests.cs:line 42\n   at System.RuntimeMethodHandle.Invoke()" },
      { name: "Override_Persists", outcome: "Failed", message: "System.NotImplementedException: The method or operation is not implemented." },
      { name: "Later", outcome: "NotExecuted" },
    ]));
    expect(p.results.map((r) => [r.id, r.outcome, r.failureKind])).toEqual([
      ["Shop.Tests::Shop.Tests.CheckoutTests.Checkout_Works", "passed", undefined],
      ["Shop.Tests::Shop.Tests.CheckoutTests.Checkout_Rejects", "failed", "assertion"],
      ["Shop.Tests::Shop.Tests.CheckoutTests.Override_Persists", "failed", "not-implemented"],
      ["Shop.Tests::Shop.Tests.CheckoutTests.Later", "skipped", undefined],
    ]);
    expect(p.results[1]!.frames).toEqual(["at Shop.Tests.CheckoutTests.Checkout_Rejects() in CheckoutTests.cs:line 42"]);
  });

  it("classifies failures", () => {
    expect(classifyFailure("Npgsql.NpgsqlException: Failed to connect to 127.0.0.1:5432")).toBe("infra");
    expect(classifyFailure("System.NullReferenceException: Object reference not set")).toBe("exception");
    expect(classifyFailure("Test timed out after 30s")).toBe("timeout");
  });

  it("rejects a non-TRX file", () => {
    expect(() => parseTrx("<x/>")).toThrow();
  });
});

describe("validity", () => {
  const exp = { expectPass: ["P::A"], expectFail: [], compareToBaseline: [] };
  const ok = { reports: [{ sha: "s", parsed: true, writtenAfterStart: true }], discovered: ["P::A"], exitCode: 0, results: [{ id: "P::A", outcome: "passed" as const, durationMs: 1 }] };

  it("needs every condition of §2.4", () => {
    expect(validate(ok, exp).valid).toBe(true);
    expect(validate({ ...ok, reports: [] }, exp).reason).toMatch(/no test report/);
    expect(validate({ ...ok, reports: [{ sha: "s", parsed: true, writtenAfterStart: false }] }, exp).reason).toMatch(/older/);
    expect(validate({ ...ok, results: [] }, exp).valid).toBe(false);
    expect(validate({ ...ok, exitCode: 1 }, exp).reason).toMatch(/exited 1/);
    expect(validate({ ...ok, results: [{ id: "P::A", outcome: "failed", durationMs: 1 }] }, exp).reason).toMatch(/exited 0/);
  });

  it("calls it infra only when the probe fails", () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: `P::T${i}`, outcome: "failed" as const, failureKind: "infra" as const, durationMs: 1 }));
    expect(classify(many, () => true)).toBe("code");
    expect(classify(many, () => false)).toBe("infra");
    expect(classify(many.slice(0, 2), () => false)).toBe("code");
  });

  it("marks a failed build as compile failures of the expected tests", () => {
    const run = buildTestRun({ treeSha: "a".repeat(40), stage: "task", toolVersions: {}, exp, raw: { reports: [], results: [], discovered: [], exitCode: 1, buildFailed: true }, probeOk: () => true });
    expect(run.valid).toBe(true);
    expect(run.results[0]).toMatchObject({ id: "P::A", failureKind: "compile" });
  });
});

describe("re-runs", () => {
  it("a new failure gets its second chance even when the repo has many known failures", () => {
    const known = Array.from({ length: 100 }, (_, i) => `K::t${i}`);
    const results = [...known, "J::Timing", "L::Locked"].map((id) => ({ id, outcome: "failed" as const, durationMs: 1 }));
    const exp = { expectPass: ["L::Locked"], expectFail: [], compareToBaseline: [] };
    expect(rerunCandidates(results, exp, new Set(known))).toEqual(["J::Timing"]);
    // without the baseline it's everything unlocked (the old behaviour, over the limit of 20)
    expect(rerunCandidates(results, exp)).toHaveLength(101);
  });
});

describe("helpers", () => {
  it("parses build errors", () => {
    const log = "/src/src/Api/Checkout.cs(12,5): error CS0103: The name 'x' does not exist [/src/src/Api/Api.csproj]\nBuild FAILED.";
    expect(parseBuildErrors(log)).toEqual([{ file: "src/Api/Checkout.cs", line: 12, code: "CS0103", msg: "The name 'x' does not exist" }]);
  });

  it("builds a test filter from IDs", () => {
    expect(filterFor(["P::Ns.C.A(x: 1)", "P::Ns.C.B"])).toBe("FullyQualifiedName=Ns.C.A|FullyQualifiedName=Ns.C.B");
  });
});

/** A fake runtime: records specs and writes a TRX into the results mount of test containers. */
class FakeRuntime implements ContainerRuntime {
  binary = "fake";
  specs = new Map<string, ContainerSpec>();
  removed: string[] = [];
  stopped: string[] = [];
  n = 0;
  constructor(private readonly behave: { build?: number; trx?: string; exit?: number }) {}
  async version() { return "fake"; }
  async create(s: ContainerSpec) { const id = `c${++this.n}`; this.specs.set(id, s); return id; }
  async start() {}
  async wait(id: string) {
    const s = this.specs.get(id)!;
    if (s.cmd[1] === "build") return this.behave.build ?? 0;
    if (s.cmd[1] === "test") {
      const res = s.mounts.find((m) => m.dst === "/results")!;
      writeFileSync(join(res.src, "r_1.trx"), this.behave.trx ?? "");
      return this.behave.exit ?? 0;
    }
    return 0;
  }
  async exec() { return { code: 0, stdout: "", stderr: "" }; }
  async isRunning() { return true; }
  async logs() { return ""; }
  async stop(id: string) { this.stopped.push(id); }
  async remove(id: string) { this.removed.push(id); }
  async listByLabel() { return []; }
  async imageDigest(i: string) { return `${i}@sha256:x`; }
}

function repoWithCommit(): { repo: string; commit: string } {
  const repo = mkdtempSync(join(tmpdir(), "factory-repo-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q"], { cwd: repo, env });
  writeFileSync(join(repo, "App.sln"), "");
  execFileSync("git", ["add", "."], { cwd: repo, env });
  execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: repo, env });
  return { repo, commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim() };
}

describe(".NET producer (fake runtime)", () => {
  const project = ProjectConfig.parse({
    project: "shop", repo: "/x", stack: "dotnet",
    database: { producerEnv: { ConnectionStrings__Default: "Host={{DB_HOST}};Password={{DB_PASSWORD}}" } },
  });

  it("builds offline, tests in the db namespace, stops before reading, cleans up", async () => {
    const { repo, commit } = repoWithCommit();
    const rt = new FakeRuntime({ trx: trx([{ name: "A", outcome: "Passed" }]) });
    const out = await produceDotnetTests({
      runId: "r1", key: "implement/TASK-1/1", repo, commit, stage: "task", project, rt,
      exp: { expectPass: ["Shop.Tests::Shop.Tests.CheckoutTests.A"], expectFail: [], compareToBaseline: [] },
    });
    expect(out.testRun.valid).toBe(true);
    expect(out.testRun.classification).toBe("ok");
    const specs = [...rt.specs.values()];
    const build = specs.find((s) => s.cmd[1] === "build")!;
    const test = specs.find((s) => s.cmd[1] === "test")!;
    const db = specs.find((s) => s.role === "db")!;
    expect(build.network).toBe("none");
    expect(db.network).toBe("none");
    expect(test.network).toBe(`container:c3`);
    expect(test.env.ConnectionStrings__Default).toMatch(/^Host=127\.0\.0\.1;Password=[0-9a-f]{24}$/);
    expect(build.env.ConnectionStrings__Default).toBeUndefined();
    expect(build.mounts.find((m) => m.dst === "/nuget")?.ro).toBe(true);
    expect(rt.removed.sort()).toEqual([...rt.specs.keys()].sort());
  });

  it("reports a failed build as compile failures", async () => {
    const { repo, commit } = repoWithCommit();
    const rt = new FakeRuntime({ build: 1 });
    const out = await produceDotnetTests({
      runId: "r1", key: "k", repo, commit, stage: "task", project, rt,
      exp: { expectPass: ["P::A"], expectFail: [], compareToBaseline: [] },
    });
    expect(out.build.ok).toBe(false);
    expect(out.testRun.results[0]?.failureKind).toBe("compile");
    expect([...rt.specs.values()].some((s) => s.cmd[1] === "test")).toBe(false);
  });

  it("marks a report invalid when an expected test is missing", async () => {
    const { repo, commit } = repoWithCommit();
    const rt = new FakeRuntime({ trx: trx([{ name: "Other", outcome: "Passed" }]) });
    const out = await produceDotnetTests({
      runId: "r1", key: "k", repo, commit, stage: "task", project, rt,
      exp: { expectPass: ["Shop.Tests::Shop.Tests.CheckoutTests.A"], expectFail: [], compareToBaseline: [] },
    });
    expect(out.testRun.valid).toBe(false);
  });
});
