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
function answerFor(system: string): unknown {
  if (system.includes("intake step")) return { source: "cli", spans: [{ id: "I-1", text: "greet with Hello" }], changeClass: "feature", risk: "low", riskTags: [], rigor: "light", touchesUi: false };
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
  async version() { return "fake"; }
  async create(s: ContainerSpec) { const id = `c${++this.n}`; this.specs.set(id, s); return id; }
  async start() {}
  async wait(id: string) {
    const s = this.specs.get(id)!;
    const mount = (dst: string) => s.mounts.find((m) => m.dst === dst)?.src;
    if (s.role === "agent") {
      const work = mount("/work")!;
      const job = JSON.parse(readFileSync(mount("/job/in.json")!, "utf8")) as { fileScope: string[] };
      const out = mount("/job/out")!;
      if (job.fileScope.includes("tests/**")) {
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
    if (s.cmd[1] === "test") {
      const src = mount("/src")!;
      const results = [{ name: "CHAR_Works", outcome: "Passed" }];
      let code = 0;
      if (existsSync(join(src, "tests/Api.Tests/GreetTests.cs"))) {
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
  expect(r2.status).toBe("waiting");
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
});
