// End to end: the brownfield slice with a scripted model and a fake container runtime.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import "../gates/predicates.js";
import { verifyEvidence } from "../gates/engine.js";
import { decide } from "../ledger/human.js";
import { HUMAN_WRITER, Ledger } from "../ledger/ledger.js";
import { replay } from "../ledger/state.js";
import type { Conversation, Provider, Turn } from "../runners/api.js";
import { setSkipInfra } from "../runners/netinfra.js";
import type { ContainerRuntime, ContainerSpec } from "../verify/runtime.js";
import { trx } from "../verify/testutil.js";
import { createRun, execute } from "./executor.js";
import { setProviderFactory } from "./think.js";
import { setRuntime } from "./workspace.js";
import { _resetEnvCache } from "../config/env.js";

const GREETER = `namespace Api;
public class Greeter
{
    public string Greet(string name) => "Hi " + name;
}
`;
const AC_ID = "Api.Tests::Api.Tests.GreetTests.AC_1_1_GreetsWithHello";
const CHAR_ID = "Api.Tests::Api.Tests.ExistingTests.CHAR_Works";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-e2e-repo-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  mkdirSync(join(dir, "src/Api"), { recursive: true });
  mkdirSync(join(dir, "tests/Api.Tests"), { recursive: true });
  writeFileSync(join(dir, "src/Api/Greeter.cs"), GREETER);
  writeFileSync(join(dir, "tests/Api.Tests/ExistingTests.cs"), "namespace Api.Tests; public class ExistingTests { }\n");
  writeFileSync(join(dir, "src/Api/Api.csproj"), '<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n');
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

// ---------- scripted model ----------
const U = { inputTokens: 2000, outputTokens: 300, cacheRead: 0, cacheWrite: 0 };
/** Three tasks, one criterion each: Greeter says Hello, Farewell says Bye, Third says Three. */
let multi = false;
/** intake's risk: "low" takes the light lane, "medium" the full one */
let intakeRisk = "low";
const MULTI_FILES = ["src/Api/Greeter.cs", "src/Api/Farewell.cs", "src/Api/Third.cs"];
const MULTI_TESTS = ["AC_1_1_GreetsWithHello", "AC_2_1_SaysBye", "AC_3_1_CountsThree"];
function multiAnswer(system: string): unknown {
  if (system.includes("Senior engineer writing a behaviour spec")) {
    const one = answerFor(system, false) as { requirements: unknown[] };
    const req = (n: number, then: string) => ({ id: `REQ-${n}`, ears: `When called, the service shall ${then}.`, op: "ADDED", sources: ["I-1"], anchors: [],
      acceptance: [{ id: `AC-${n}.1`, given: "a call", when: "it runs", then: `the returned value is ${then.replace("say ", "")}`, level: "api" }] });
    return { ...one, requirements: [...one.requirements, req(2, "say Bye"), req(3, "say Three")] };
  }
  if (system.includes("Merge three independent")) {
    const one = answerFor(system, false) as Record<string, unknown>;
    return { ...one, spec: multiAnswer("Senior engineer writing a behaviour spec"), alignment: [1, 2, 3].map((n) => ({ mergedReq: `REQ-${n}`, from: [`d1:REQ-${n}`, `d2:REQ-${n}`, `d3:REQ-${n}`] })) };
  }
  if (system.includes("plan the implementation")) {
    const one = answerFor(system, false) as { tasks: { reqs: string[]; fileScope: string[] }[] };
    const t = (n: number) => ({ id: `TASK-${n}`, title: `Part ${n}`, reqs: [`REQ-${n}`], fileScope: [MULTI_FILES[n - 1]!], exemplars: [], conventions: [], dependsOn: n > 1 ? [`TASK-${n - 1}`] : [], plannedLoc: 3, approach: "small edit" });
    return { ...one, tasks: [t(1), t(2), t(3)] };
  }
  return undefined;
}
function answerFor(system: string, allowMulti = true): unknown {
  if (multi && allowMulti) { const m = multiAnswer(system); if (m !== undefined) return m; }
  if (system.includes("intake step")) return { source: "cli", spans: [{ id: "I-1", text: "greet with Hello" }], changeClass: "feature", risk: intakeRisk, riskTags: [], rigor: "light", touchesUi: false };
  if (system.includes("grounding step")) return { claims: [{ id: "C-1", text: "Greeter says Hi", spans: ["I-1"], anchors: [{ path: "src/Api/Greeter.cs", lineStart: 4, lineEnd: 4, quote: 'public string Greet(string name) => "Hi " + name;', symbol: "Greeter.Greet" }] }], notFound: [] };
  if (system.includes("independently reading a change request")) return { spans: [{ id: "I-1", behaviours: [{ text: system.length % 2 ? "Hello Ann" : "Hello, Ann!", kind: "happy" }, { text: "empty name returns Hello", kind: "error" }] }] };
  if (system.includes("Three engineers independently")) return { differences: [{ id: "D-1", span: "I-1", topic: "punctuation", readings: [{ sketch: 1, behaviour: 0, summary: "Hello Ann" }, { sketch: 2, behaviour: 0, summary: "Hello, Ann!" }] }] };
  if (system.includes("Requirements analyst")) return system.includes("already answered") ? { questions: [], conflicts: [] } : {
    questions: [{ id: "q1", category: "scope", text: "Keep the comma?", options: ["Hello Ann", "Hello, Ann!"], recommended: "Hello Ann", reason: "shortest", spans: ["I-1"], impact: 2, impactReason: "visible text", difference: "D-1" }], conflicts: [] };
  if (system.includes("Merge three independent")) return { spec: answerFor("Senior engineer writing a behaviour spec"), alignment: [{ mergedReq: "REQ-1", from: ["d1:REQ-1", "d2:REQ-1", "d3:REQ-1"] }], conflicts: [] };
  if (system.includes("State, as numbered")) return { sentences: [{ n: 1, text: "Greetings start with Hello." }] };
  if (system.includes("Map each restated")) return { mapping: [{ n: 1, spans: ["I-1"], answers: [] }] };
  if (system.includes("Senior engineer writing a behaviour spec")) return {
    requirements: [{ id: "REQ-1", ears: "When a name is given, the Greeter shall return a greeting that starts with Hello.", op: "MODIFIED", sources: ["I-1"],
      anchors: [{ path: "src/Api/Greeter.cs", lineStart: 4, lineEnd: 4, quote: 'public string Greet(string name) => "Hi " + name;' }],
      acceptance: [{ id: "AC-1.1", given: "a name Ann", when: "Greet is called", then: "the returned value is Hello Ann", level: "api" }] }],
    nfrs: [], outOfScope: ["other greetings"], assumptions: [], suggestions: [],
  };
  if (system.includes("Adversarial reviewer")) return { findings: [] };
  if (system.includes("plan the implementation")) return {
    tasks: [{ id: "TASK-1", title: "Say Hello", reqs: ["REQ-1"], fileScope: ["src/Api/Greeter.cs"], exemplars: [], conventions: [], dependsOn: [], plannedLoc: 3, approach: "change the literal" }],
    options: [{ id: "O-1", summary: "change the literal", simplest: true, tradeoffs: "none" }, { id: "O-2", summary: "make it configurable", simplest: false, tradeoffs: "more code" }],
    chosen: "O-1", adr: "Change the literal; configuration isn't asked for.", protectedPathsDeclared: [], newDependencies: [], stubs: [],
  };
  if (system.includes("review a finished change")) return { findings: [] };
  throw new Error(`unscripted system prompt: ${system.slice(0, 80)}`);
}
const modelCalls: string[] = [];
const provider: Provider = {
  start(model, _e, system): Conversation {
    modelCalls.push(model);
    return {
      async next(): Promise<Turn> { return { calls: [{ id: "s", name: "submit_result", input: answerFor(system) }], text: "", stop: "tool_use", usage: U }; },
      toolResults() {}, say() {},
    };
  },
};

// ---------- fake containers: tests pass once Greeter says Hello ----------
class Lab implements ContainerRuntime {
  binary = "fake";
  specs = new Map<string, ContainerSpec>();
  n = 0;
  crashOnImplement = false;
  /** multi: per file scope, the files each implement attempt writes (the last entry repeats) */
  edits: Record<string, Record<string, string>[]> = {};
  /** multi: what each implement attempt found before it edited */
  seen: { scope: string; head: string; task: string; files: Record<string, string | null> }[] = [];
  /** every coding-agent job as the container got it (model, limits, scope) */
  jobs: { model: string; maxTurns: number; maxUsd: number; fileScope: string[]; system: string }[] = [];
  async version() { return "fake"; }
  async create(s: ContainerSpec) { const id = `c${++this.n}`; this.specs.set(id, s); return id; }
  async start() {}
  async wait(id: string) {
    const s = this.specs.get(id)!;
    const mount = (dst: string) => s.mounts.find((m) => m.dst === dst)?.src;
    if (s.role === "agent") {
      const work = mount("/work")!;
      const job = JSON.parse(readFileSync(mount("/job/in.json")!, "utf8")) as { fileScope: string[] };
      this.jobs.push(job as never);
      const out = mount("/job/out")!;
      if (multi && job.fileScope.includes("tests/**")) {
        writeFileSync(join(work, "tests/Api.Tests/GreetTests.cs"), "namespace Api.Tests; public class GreetTests { }\n");
        writeFileSync(join(out, "result.json"), JSON.stringify({ status: "ok", output: { tests: MULTI_TESTS.map((name, i) => ({ acId: `AC-${i + 1}.1`, file: "tests/Api.Tests/GreetTests.cs", name })), characterisation: [{ target: "Greeter", file: "tests/Api.Tests/ExistingTests.cs", name: "CHAR_Works" }], probes: [], notes: "" }, instructionsLoaded: [], deniedEdits: [], usage: { input_tokens: 5000, output_tokens: 800 }, costUsd: 0.05, turns: 6 }));
      } else if (multi) {
        const job2 = JSON.parse(readFileSync(mount("/job/in.json")!, "utf8")) as { fileScope: string[]; task: string };
        const scope = job2.fileScope[0]!;
        const read = (f: string) => (existsSync(join(work, f)) ? readFileSync(join(work, f), "utf8") : null);
        this.seen.push({ scope, head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: work, encoding: "utf8" }).trim(), task: job2.task,
          files: Object.fromEntries([...MULTI_FILES, "src/Api/Extra.cs"].map((f) => [f, read(f)])) });
        const list = this.edits[scope]!;
        const edit = list.length > 1 ? list.shift()! : list[0]!;
        for (const [f, text] of Object.entries(edit)) writeFileSync(join(work, f), text);
        writeFileSync(join(out, "result.json"), JSON.stringify({ status: "ok", output: { done: true, filesChanged: Object.keys(edit), notes: "" }, instructionsLoaded: [], deniedEdits: [], usage: { input_tokens: 8000, output_tokens: 900 }, costUsd: 0.08, turns: 9 }));
      } else if (job.fileScope.includes("tests/**")) {
        writeFileSync(join(work, "tests/Api.Tests/GreetTests.cs"), "namespace Api.Tests; public class GreetTests { /* AC-1.1 */ }\n");
        writeFileSync(join(out, "result.json"), JSON.stringify({ status: "ok", output: { tests: [{ acId: "AC-1.1", file: "tests/Api.Tests/GreetTests.cs", name: "AC_1_1_GreetsWithHello" }], characterisation: [{ target: "Greeter", file: "tests/Api.Tests/ExistingTests.cs", name: "CHAR_Works" }], probes: [{ acId: "AC-1.1", method: "GET", path: "/greet/Ann", expectStatus: 200 }], notes: "" }, instructionsLoaded: [], deniedEdits: [], usage: { input_tokens: 5000, output_tokens: 800 }, costUsd: 0.05, turns: 6 }));
      } else {
        if (this.crashOnImplement) { this.crashOnImplement = false; throw new Error("simulated crash"); }
        writeFileSync(join(out, "progress.jsonl"), [
          { ts: 1, kind: "start", model: "claude-sonnet-5" },
          { ts: 2, kind: "tool", tool: "Edit", target: "src/Api/Greeter.cs" },
          { ts: 3, kind: "end", status: "ok", turns: 9, costUsd: 0.08 },
        ].map((x) => JSON.stringify(x)).join("\n") + "\n");
        writeFileSync(join(work, "src/Api/Greeter.cs"), GREETER.replace('"Hi "', '"Hello "'));
        writeFileSync(join(out, "result.json"), JSON.stringify({ status: "ok", output: { done: true, filesChanged: ["src/Api/Greeter.cs"], notes: "" }, instructionsLoaded: [], deniedEdits: [], usage: { input_tokens: 8000, output_tokens: 900 }, costUsd: 0.08, turns: 9 }));
      }
      return 0;
    }
    if (multi && s.cmd[1] === "build") {
      const src = mount("/src")!;
      return MULTI_FILES.some((f) => existsSync(join(src, f)) && readFileSync(join(src, f), "utf8").includes("SYNTAX")) ? 1 : 0;
    }
    if (s.cmd[1] === "test") {
      const src = mount("/src")!;
      const results = [{ name: "CHAR_Works", outcome: "Passed" }];
      let code = 0;
      if (multi && existsSync(join(src, "tests/Api.Tests/GreetTests.cs"))) {
        const read = (f: string) => (existsSync(join(src, f)) ? readFileSync(join(src, f), "utf8") : "");
        // Greeter's test also breaks when Farewell says BREAK: a later task can break an earlier one
        const pass = [read("src/Api/Greeter.cs").includes('"Hello "') && !read("src/Api/Farewell.cs").includes("BREAK"), read("src/Api/Farewell.cs").includes("Bye"), read("src/Api/Third.cs").includes("Three")];
        MULTI_TESTS.forEach((name, i) => results.push(pass[i] ? { name, outcome: "Passed" } : { name, outcome: "Failed", message: `Assert.Equal() Failure: ${name}` } as never));
        if (pass.includes(false)) code = 1;
      } else if (existsSync(join(src, "tests/Api.Tests/GreetTests.cs"))) {
        const done = readFileSync(join(src, "src/Api/Greeter.cs"), "utf8").includes('"Hello "');
        results.push(done ? { name: "AC_1_1_GreetsWithHello", outcome: "Passed" } : { name: "AC_1_1_GreetsWithHello", outcome: "Failed", message: "Assert.Equal() Failure: Expected Hello Ann, Actual Hi Ann" } as never);
        if (!done) code = 1;
      }
      const withCls = results.map((r) => ({ ...r, cls: r.name === "CHAR_Works" ? "ExistingTests" : "GreetTests" }));
      writeFileSync(join(mount("/results")!, "r_Api.Tests.trx"), trx(withCls, "Api.Tests", "Api.Tests"));
      return code;
    }
    return 0;
  }
  appRequests: string[] = [];
  async exec(id: string, cmd: string[]) {
    const s = this.specs.get(id)!;
    if (s.role === "app" && cmd[0] === "curl") {
      const url = cmd[cmd.length - 1]!;
      if (cmd.includes("-o")) return { code: 0, stdout: "404", stderr: "" }; // ready check: any answer
      this.appRequests.push(url);
      const src = s.mounts.find((m) => m.dst === "/src")!.src;
      const hello = readFileSync(join(src, "src/Api/Greeter.cs"), "utf8").includes('"Hello "');
      return { code: 0, stdout: hello ? "Hello Ann\n200" : "Hi Ann\n500", stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  }
  async isRunning() { return true; }
  async logs() { return "info: Now listening on: http://127.0.0.1:5080"; }
  async stop() {}
  async remove() {}
  async listByLabel() { return []; }
  async imageDigest(i: string) { return `${i}@sha256:fake`; }
}

/** First execute stops at the question card; answer it; the next stops at the approval card. */
async function toApproval(runId: string) {
  const r1 = await execute(runId);
  expect(r1.status).toBe("waiting");
  const ledger = Ledger.open(runId);
  const q = replay(ledger.events()).openCard!;
  expect(q.kind).toBe("question");
  expect(ledger.readCard(q.cardId)).toContain("Keep the comma?");
  await decide(ledger, { decision: "answer", hashPrefix: q.artifactSha.slice(0, 6), by: "ahsan", data: { answers: { "Q-1": "A" } } });
  const r2 = await execute(runId);
  expect(r2.status, r2.message).toBe("waiting");
  return ledger;
}

let lab: Lab;
beforeEach(() => {
  const home = mkdtempSync(join(tmpdir(), "factory-e2e-"));
  process.env.FACTORY_HOME = home;
  writeFileSync(join(home, ".env"), "ANTHROPIC_API_KEY=sk-ant-test-not-real-000000000000\n", { mode: 0o600 });
  _resetEnvCache();
  const repo = makeRepo();
  mkdirSync(join(home, "projects"), { recursive: true });
  writeFileSync(join(home, "projects", "demo.yaml"), stringify({ project: "demo", repo, stack: "dotnet", database: { producerEnv: { ConnectionStrings__Default: "Host={{DB_HOST}};Password={{DB_PASSWORD}}" } } }));
  lab = new Lab();
  setRuntime(lab);
  setSkipInfra(true);
  setProviderFactory(() => provider);
  modelCalls.length = 0;
  multi = false;
  intakeRisk = "low";
});

describe("brownfield slice end to end (fakes)", () => {
  it("runs to the approval card, then to a locally delivered branch", async () => {
    const runId = await createRun("Greet people with Hello instead of Hi", "demo", "tester");
    const ledger = await toApproval(runId);
    const s1 = replay(ledger.events());
    expect(s1.openCard?.kind).toBe("approval");
    const card = ledger.readCard(s1.openCard!.cardId);
    expect(card).toContain("> Greet people with Hello instead of Hi");
    expect(card).toContain("src/Api/Greeter.cs");
    expect(card).toContain("Q-1 Keep the comma? → **Hello Ann**");
    expect(card).toContain("Round trip: the spec restated back matches");

    await expect(decide(ledger, { decision: "approve", hashPrefix: "ffff" })).rejects.toThrow();
    await decide(ledger, { decision: "approve", hashPrefix: s1.openCard!.artifactSha.slice(0, 6), by: "ahsan", data: { note: "low risk" } });

    const done = await execute(runId);
    expect(done.status).toBe("delivered");
    const s2 = replay(ledger.events());
    expect(s2.status).toBe("delivered");
    for (const step of ["discover", "intake", "ground", "clarify", "clarify-2", "drafts", "merge", "specify", "plan", "approve", "stub-commit", "author-tests", "implement/TASK-1", "integrate", "accept", "review", "deliver"]) {
      expect(s2.steps.get(step)?.status, step).toBe("completed");
    }
    // author-tests ran the AC test on base twice and it failed for the right reason
    const gates = s2.gates.map((g) => `${g.gateId}:${g.passed}`);
    expect(gates).toContain("author-tests.fails-on-base:true");
    expect(gates).toContain("tests.expectations:true");
    expect(gates).toContain("deliver.sha-binding:true");
    // the branch holds the change, the locked test and exactly one manifest commit on top
    const repo = s2.info.repoPath!;
    const log = execFileSync("git", ["log", "--format=%s", `main..factory/${runId}`], { cwd: repo, encoding: "utf8" }).trim().split("\n");
    expect(log[0]).toMatch(/evidence manifest/);
    expect(log.some((l) => l.includes("TASK-1"))).toBe(true);
    // cost recorded per model call; every decision re-checks
    expect(s2.costUsd).toBeGreaterThan(0);
    expect(verifyEvidence(ledger).every((c) => c.ok)).toBe(true);
    // thinking steps used Opus 5.5 for ground/spec/plan
    expect(modelCalls).toContain("claude-opus-5-5");
    expect(ledger.readCard(`pr-${runId}`)).toContain("AC-1.1");
    expect(ledger.readCard(`pr-${runId}`)).toContain("Security review (OWASP Top 10): nothing found");
    // the trace shows every level: steps, model turns, lab phases, containers, gates, the coding agent's actions
    const trace = readFileSync(join(ledger.dir, "run.log"), "utf8");
    for (const want of [/▶ intake/, /intake turn 1 claude-haiku-4-5 .*→ answered/, /lab: build ok/, /lab: tests ran/, /container producer started/,
      /gate author-tests.fails-on-base passed/, /implementer: Edit src\/Api\/Greeter.cs/, /implementer: agent finished: ok after 9 turns/, /lab: app started/, /lab: probe GET \/greet\/Ann → 200/]) {
      expect(trace, String(want)).toMatch(want);
    }
    expect(trace).not.toContain("sk-ant-test-not-real");
    // the scorecard covers every step, with cost where a model ran
    const { scoreRun, formatRun } = await import("../report.js");
    const score = scoreRun(ledger);
    expect(score.steps.find((x) => x.step === "plan")).toMatchObject({ outcome: "completed", firstTimePass: true, attempts: 1 });
    expect(score.steps.find((x) => x.step === "plan")!.costUsd).toBeGreaterThan(0);
    expect(score.steps.find((x) => x.step === "clarify")!.human).toMatchObject({ questionsAsked: 1, answersChanged: 0 });
    expect(score.steps.find((x) => x.step === "approve")!.human.decisions).toEqual(["approve"]);
    expect(formatRun(score)).toMatch(/implement\/TASK-1 +completed/);
    expect(existsSync(join(ledger.dir, "report.json"))).toBe(true);
    // created/delivered times and every card asked, for the outcome numbers
    expect(Date.parse(score.deliveredAt!)).toBeGreaterThanOrEqual(Date.parse(score.createdAt!));
    expect(score.humanCards).toEqual(["question", "approval"]);
    // accept booted the app next to the test db and replayed the locked probe as evidence
    const app = [...lab.specs.values()].find((sp) => sp.role === "app")!;
    expect(app.cmd).toEqual(["dotnet", "run", "--no-build", "--no-launch-profile", "--project", "src/Api/Api.csproj", "--urls", "http://127.0.0.1:5080"]);
    expect(app.network).toMatch(/^container:/);
    expect(lab.appRequests).toEqual(["http://127.0.0.1:5080/greet/Ann"]);
    const ev = ledger.getJson<{ items: { ac: string; kind: string; passed: boolean; http: { status: number; bodySha: string }[] }[]; app: { ok: boolean } }>(s2.steps.get("accept")!.outputs[0]!);
    expect(ev.app.ok).toBe(true);
    expect(ev.items[0]).toMatchObject({ ac: "AC-1.1", kind: "http", passed: true });
    expect(ledger.getArtifact(ev.items[0]!.http[0]!.bodySha).toString()).toBe("Hello Ann");
  });

  it("resumes after a crash mid-implement without redoing finished steps", async () => {
    const runId = await createRun("Greet people with Hello instead of Hi", "demo", "tester");
    const ledger = await toApproval(runId);
    const card = replay(ledger.events()).openCard!;
    await decide(ledger, { decision: "approve", hashPrefix: card.artifactSha.slice(0, 6), by: "ahsan" });

    lab.crashOnImplement = true;
    const r = await execute(runId);
    // the agent error is a normal failed attempt; the ladder retries and the run still delivers
    expect(r.status).toBe("delivered");
    const s = replay(ledger.events());
    expect(s.steps.get("implement/TASK-1")?.attempts).toBe(2);
    expect(s.steps.get("plan")?.attempts).toBe(1);

    // a torn write at the end of the ledger is repaired on the next append
    const { appendFileSync } = await import("node:fs");
    appendFileSync(ledger.eventsPath, '{"seq":999,"ty');
    await ledger.append({ type: "run.pause-requested" }, HUMAN_WRITER);
    expect(ledger.events().some((e) => e.type === "ledger.repaired")).toBe(true);
  });

  it("parks when a coding step keeps failing a safety gate", async () => {
    const runId = await createRun("Greet people with Hello instead of Hi", "demo", "tester");
    const ledger = await toApproval(runId);
    const card = replay(ledger.events()).openCard!;
    await decide(ledger, { decision: "approve", hashPrefix: card.artifactSha.slice(0, 6), by: "ahsan" });
    // make the implementer also edit the locked test
    const orig = lab.wait.bind(lab);
    lab.wait = async (id: string) => {
      const s = lab.specs.get(id)!;
      const code = await orig(id);
      if (s.role === "agent" && !JSON.parse(readFileSync(s.mounts.find((m) => m.dst === "/job/in.json")!.src, "utf8")).fileScope.includes("tests/**")) {
        writeFileSync(join(s.mounts.find((m) => m.dst === "/work")!.src, "tests/Api.Tests/GreetTests.cs"), "// weakened\n");
      }
      return code;
    };
    const r = await execute(runId);
    expect(r.status).toBe("parked");
    expect(r.message).toMatch(/Safety check failed twice/);
  });

  it("a rejection revises the spec and plan and shows a new card; a second rejection parks", async () => {
    const runId = await createRun("Greet people with Hello instead of Hi", "demo", "tester");
    const ledger = await toApproval(runId);
    const card1 = replay(ledger.events()).openCard!;
    const before = modelCalls.length;
    await decide(ledger, { decision: "reject", hashPrefix: card1.artifactSha.slice(0, 6), by: "ahsan", data: { reason: "Keep 'Hi' for admins" } });
    const r2 = await execute(runId);
    expect(r2.status).toBe("waiting");
    const card2 = replay(ledger.events()).openCard!;
    expect(card2.kind).toBe("approval");
    expect(card2.artifactSha).not.toBe(card1.artifactSha);
    expect(modelCalls.length).toBeGreaterThan(before); // spec + plan re-ran
    const s = replay(ledger.events());
    expect(s.steps.get("specify")?.attempts).toBe(2);
    expect(s.steps.get("plan")?.attempts).toBe(2);
    expect(s.steps.get("clarify")?.attempts).toBe(1); // earlier steps untouched
    // an old hash can't approve the new card
    await expect(decide(ledger, { decision: "approve", hashPrefix: card1.artifactSha.slice(0, 6) })).rejects.toThrow();
    await decide(ledger, { decision: "reject", hashPrefix: card2.artifactSha.slice(0, 6), by: "ahsan", data: { reason: "still wrong" } });
    const r3 = await execute(runId);
    expect(r3.status).toBe("parked");
    expect(r3.message).toMatch(/Rejected 2 times/);
  });

  it("a request can come from a Markdown file; its name shows on the card", async () => {
    const { readRequestFile, MAX_REQUEST_FILE_BYTES } = await import("./executor.js");
    const dir = mkdtempSync(join(tmpdir(), "factory-req-"));
    const md = join(dir, "request.md");
    writeFileSync(md, "# Greeting\n\nGreet people with Hello instead of Hi.\n\n- keep the name after the greeting\n");
    const file = readRequestFile(md);
    expect(file.name).toBe("request.md");
    const runId = await createRun(file.text, "demo", "tester", { requestFile: file.name });
    const ledger = Ledger.open(runId);
    const s = replay(ledger.events());
    expect(s.info.requestFile).toBe("request.md");
    expect(s.info.request).toBe(file.text);
    const withCard = await toApproval(runId);
    const card = withCard.readCard(replay(withCard.events()).openCard!.cardId);
    expect(card).toContain("## Your request (word for word, from request.md)");
    expect(card).toContain("> - keep the name after the greeting");
    // too big or empty files are refused before a run exists
    const big = join(dir, "big.md");
    writeFileSync(big, "x".repeat(MAX_REQUEST_FILE_BYTES + 1));
    expect(() => readRequestFile(big)).toThrow(/split the request/);
    writeFileSync(join(dir, "empty.md"), "  \n");
    expect(() => readRequestFile(join(dir, "empty.md"))).toThrow(/empty/);
    expect(() => readRequestFile(join(dir, "missing.md"))).toThrow(/No such file/);
  });
});

describe("implement loop across tasks (fakes)", () => {
  const HELLO = GREETER.replace('"Hi "', '"Hello "');
  const cls = (text: string) => `namespace Api; public static class X { public const string S = "${text}"; }\n`;
  const failedAttempts = (ledger: Ledger, step: string) => ledger.events().filter((e) => e.type === "step.failed" && e.key?.startsWith(`${step}/`));

  it("holds each task to earlier tasks' tests, climbs on regressions, keeps code on same-rung retries", async () => {
    multi = true;
    lab.edits = {
      // TASK-1: first attempt also writes a file outside its scope → reset
      "src/Api/Greeter.cs": [{ "src/Api/Greeter.cs": HELLO, "src/Api/Extra.cs": cls("extra") }, { "src/Api/Greeter.cs": HELLO }],
      // TASK-2: breaks TASK-1's test twice (same rung, then stuck → climbs), then gets it right
      "src/Api/Farewell.cs": [{ "src/Api/Farewell.cs": cls("Bye BREAK") }, { "src/Api/Farewell.cs": cls("Bye BREAK") }, { "src/Api/Farewell.cs": cls("Bye") }],
      // TASK-3: its own locked test fails once, then a small fix on top of the kept code
      "src/Api/Third.cs": [{ "src/Api/Third.cs": cls("Thre") }, { "src/Api/Third.cs": cls("Three") }],
    };
    const runId = await createRun("Greet people with Hello instead of Hi", "demo", "tester");
    const ledger = await toApproval(runId);
    const card = replay(ledger.events()).openCard!;
    await decide(ledger, { decision: "approve", hashPrefix: card.artifactSha.slice(0, 6), by: "ahsan" });
    const r = await execute(runId);
    expect(r.status, r.message).toBe("delivered");
    const s = replay(ledger.events());
    expect(s.steps.get("implement/TASK-1")?.attempts).toBe(2);
    expect(s.steps.get("implement/TASK-2")?.attempts).toBe(3);
    expect(s.steps.get("implement/TASK-3")?.attempts).toBe(2);
    const ids = MULTI_TESTS.map((n) => `Api.Tests::Api.Tests.GreetTests.${n}`);
    const start = (task: string) => String(s.steps.get(task)!.data!.commit);

    // TASK-1: out-of-scope edit → the retry starts from the task start commit, the stray file gone
    const t1 = lab.seen.filter((x) => x.scope === MULTI_FILES[0]);
    expect(failedAttempts(ledger, "implement/TASK-1")[0]!.data).toMatchObject({ category: "other", retryMode: "reset" });
    expect(t1[1]!.files["src/Api/Extra.cs"]).toBeNull();
    expect(t1[1]!.files["src/Api/Greeter.cs"]).toBe(GREETER);
    expect(t1[1]!.head).toBe(t1[0]!.head);
    expect(t1[1]!.task).not.toContain("Your previous change");

    // TASK-2: TASK-1's test is expected; TASK-3's is not
    const t2run = ledger.getJson<{ expectPass: string[] }>(s.steps.get("implement/TASK-2")!.outputs[1]!);
    expect(t2run.expectPass).toContain(ids[0]);
    expect(t2run.expectPass).toContain(ids[1]);
    expect(t2run.expectPass).not.toContain(ids[2]);
    // a regression names TASK-1, climbs the ladder (other, not locked-test), never parks on the "failed twice" rule
    const f2 = failedAttempts(ledger, "implement/TASK-2");
    expect(f2.map((e) => e.data!.category)).toEqual(["other", "other"]);
    expect(f2.map((e) => e.data!.lockedFailedIds ?? [])).toEqual([[], []]);
    expect(f2.map((e) => [e.data!.rung, e.data!.action, e.data!.nextRung])).toEqual([[0, "retry", 0], [0, "retry", 1]]);
    const why = ledger.getJson<{ check: string; message: string }[]>(f2[0]!.outputs![0]!);
    expect(why).toContainEqual(expect.objectContaining({ check: "regression", message: expect.stringMatching(/^Your change broke TASK-1's locked test .*AC_1_1_GreetsWithHello \(AC-1\.1\)/) }));
    // same rung → keeps the code; the climb to rung 1 → starts fresh
    const t2 = lab.seen.filter((x) => x.scope === MULTI_FILES[1]);
    expect(t2[1]!.files["src/Api/Farewell.cs"]).toBe(cls("Bye BREAK"));
    expect(t2[1]!.task).toContain("Your previous change");
    expect(t2[1]!.task).toContain("don't rewrite it");
    expect(t2[2]!.files["src/Api/Farewell.cs"]).toBeNull();
    expect(t2[2]!.task).not.toContain("Your previous change");
    expect(f2[1]!.data).toMatchObject({ retryMode: "keep" });
    expect(s.steps.get("implement/TASK-2")!.data).toMatchObject({ retryMode: "reset", retryReason: "moved from rung 0 to rung 1" });

    // TASK-3: its own test failed once → the retry keeps the code, HEAD stays at the task start
    const t3 = lab.seen.filter((x) => x.scope === MULTI_FILES[2]);
    expect(t3[1]!.files["src/Api/Third.cs"]).toBe(cls("Thre"));
    expect(t3[1]!.head).toBe(start("implement/TASK-2"));
    expect(t3[1]!.task).toContain("Your previous change");
    expect(t3[1]!.task).toMatch(/\+.*Thre/);
    expect(s.steps.get("implement/TASK-3")!.data).toMatchObject({ retryMode: "keep" });
    // each task is still one commit on the branch; every gate decision re-checks
    const log = execFileSync("git", ["log", "--format=%s", `main..factory/${runId}`], { cwd: s.info.repoPath!, encoding: "utf8" });
    expect(log.match(/factory: TASK-/g)).toHaveLength(3);
    expect(verifyEvidence(ledger).every((c) => c.ok)).toBe(true);
  }, 30_000);

  it("two broken builds in a row climb the ladder instead of parking as a suspect test", async () => {
    multi = true;
    lab.edits = {
      "src/Api/Greeter.cs": [{ "src/Api/Greeter.cs": "SYNTAX" }, { "src/Api/Greeter.cs": "SYNTAX" }, { "src/Api/Greeter.cs": HELLO }],
      "src/Api/Farewell.cs": [{ "src/Api/Farewell.cs": cls("Bye") }],
      "src/Api/Third.cs": [{ "src/Api/Third.cs": cls("Three") }],
    };
    const runId = await createRun("Greet people with Hello instead of Hi", "demo", "tester");
    const ledger = await toApproval(runId);
    const card = replay(ledger.events()).openCard!;
    await decide(ledger, { decision: "approve", hashPrefix: card.artifactSha.slice(0, 6), by: "ahsan" });
    const r = await execute(runId);
    expect(r.status, r.message).toBe("delivered");
    const f1 = failedAttempts(ledger, "implement/TASK-1");
    expect(f1.map((e) => e.data!.category)).toEqual(["other", "other"]);
    expect(f1.map((e) => e.data!.lockedFailedIds ?? [])).toEqual([[], []]);
    expect(f1.map((e) => [e.data!.action, e.data!.nextRung])).toEqual([["retry", 0], ["retry", 1]]);
    // a broken build keeps the code on the same rung
    const t1 = lab.seen.filter((x) => x.scope === MULTI_FILES[0]);
    expect(t1[1]!.files["src/Api/Greeter.cs"]).toBe("SYNTAX");
    expect(t1[1]!.task).toContain("Your previous change");
  }, 30_000);
});

describe("light and full lanes (fakes)", () => {
  async function deliver() {
    const runId = await createRun("Greet people with Hello instead of Hi", "demo", "tester");
    const ledger = await toApproval(runId);
    const card = replay(ledger.events()).openCard!;
    await decide(ledger, { decision: "approve", hashPrefix: card.artifactSha.slice(0, 6), by: "ahsan" });
    const r = await execute(runId);
    expect(r.status, r.message).toBe("delivered");
    return replay(ledger.events());
  }
  const writer = () => lab.jobs.find((j) => j.fileScope.includes("tests/**"))!;

  it("a small low-risk change: one draft, no merge call, a Sonnet test writer with tight limits", async () => {
    const s = await deliver();
    expect(s.steps.get("drafts")!.data!.models).toEqual(["claude-sonnet-5"]);
    expect(s.steps.get("merge")!.data!.singleDraft).toBe(true);
    expect(s.steps.get("specify")!.data!.lane).toBe("light");
    // one question round: what round 1 didn't settle is an assumption
    expect(s.steps.get("clarify-2")!.data).toMatchObject({ skipped: true, lightLane: true });
    expect(writer()).toMatchObject({ model: "claude-sonnet-5", maxTurns: 25 });
    expect(writer().maxUsd).toBeLessThanOrEqual(4);
    expect(writer().system).toContain("At most 2 characterisation tests");
    expect(writer().system).toContain('Don\'t run "dotnet test"');
  });

  it("medium risk keeps the full lane: 3 drafts, a merge, 3 reworks allowed, an Opus test writer with $4 and 60 turns", async () => {
    intakeRisk = "medium";
    const s = await deliver();
    expect(s.steps.get("drafts")!.data!.models).toHaveLength(3);
    expect(s.steps.get("merge")!.data!.singleDraft).toBeUndefined();
    expect(s.steps.get("specify")!.data!.lane).toBe("full");
    expect(s.steps.get("clarify-2")!.data?.lightLane).toBeUndefined();
    expect(writer()).toMatchObject({ model: "claude-opus-5-5", maxTurns: 60, maxUsd: 4 });
    expect(writer().system).not.toContain("At most 2 characterisation tests");
  });
});
