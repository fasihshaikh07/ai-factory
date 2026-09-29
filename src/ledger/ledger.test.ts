import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { ExecutionLock, LockBusyError } from "./exec-lock.js";
import { decide, DecisionError, applyExpiredDeadline } from "./human.js";
import { FencedOutError, HUMAN_WRITER, Ledger, LedgerCorruptError } from "./ledger.js";
import { runSink } from "./sinks.js";
import { canSkip, eventKey, inputsHash, replay } from "./state.js";
import { checkCaps, currentCostCap } from "./caps.js";

beforeEach(() => {
  process.env.FACTORY_HOME = mkdtempSync(join(tmpdir(), "factory-test-"));
});

async function newRun(runId = "20260927-test-abcd") {
  const l = Ledger.create(runId);
  await l.append({ type: "run.created", data: { mode: "brownfield", project: "p", changeClass: "feature" } }, HUMAN_WRITER);
  return l;
}

describe("ledger", () => {
  it("appends events with increasing seq and replays state", async () => {
    const l = await newRun();
    await l.append({ type: "step.started", key: eventKey("intake", 1) }, HUMAN_WRITER);
    const out = l.putJson({ a: 1 });
    await l.append({ type: "step.completed", key: eventKey("intake", 1), inputsHash: "c".repeat(64), outputs: [out] }, HUMAN_WRITER);
    const evs = l.events();
    expect(evs.map((e) => e.seq)).toEqual([0, 1, 2]);
    const s = replay(evs);
    expect(s.steps.get("intake")?.status).toBe("completed");
    expect(canSkip(s, "intake", "c".repeat(64))).toBe(true);
    expect(canSkip(s, "intake", "d".repeat(64))).toBe(false);
    expect(l.getJson(out)).toEqual({ a: 1 });
  });

  it("repairs a torn last line before the next append", async () => {
    const l = await newRun();
    appendFileSync(l.eventsPath, '{"seq":1,"ts":"x","ru');
    expect(l.events()).toHaveLength(1);
    await l.append({ type: "step.started", key: "intake/1" }, HUMAN_WRITER);
    const evs = l.events();
    expect(evs.map((e) => e.type)).toEqual(["run.created", "ledger.repaired", "step.started"]);
    expect(readFileSync(l.eventsPath, "utf8").endsWith("\n")).toBe(true);
  });

  it("treats a bad line in the middle as corruption", async () => {
    const l = await newRun();
    await l.append({ type: "step.started", key: "intake/1" }, HUMAN_WRITER);
    const lines = readFileSync(l.eventsPath, "utf8").split("\n");
    writeFileSync(l.eventsPath, [lines[0], "garbage", lines[1], ""].join("\n"));
    expect(() => l.events()).toThrow(LedgerCorruptError);
  });

  it("detects a tampered artifact", async () => {
    const l = await newRun();
    const sha = l.putArtifact("hello");
    writeFileSync(join(l.artifactsDir, sha), "HELLO");
    expect(() => l.getArtifact(sha)).toThrow(LedgerCorruptError);
  });

  it("counts interrupted attempts separately", async () => {
    const l = await newRun();
    await l.append({ type: "step.started", key: "implement/TASK-1/1" }, HUMAN_WRITER);
    await l.append({ type: "step.interrupted", key: "implement/TASK-1/1" }, HUMAN_WRITER);
    await l.append({ type: "step.started", key: "implement/TASK-1/2" }, HUMAN_WRITER);
    await l.append({ type: "step.failed", key: "implement/TASK-1/2", data: { signature: "s1" } }, HUMAN_WRITER);
    const r = replay(l.events()).steps.get("implement/TASK-1")!;
    expect(r.attempts).toBe(1);
    expect(r.interruptions).toBe(1);
    expect(r.failureSignatures).toEqual(["s1"]);
  });

  it("inputsHash changes with any input", () => {
    const base = { inputs: ["a"], stageDef: { x: 1 }, templateVersion: "1", model: "m" };
    expect(inputsHash(base)).toBe(inputsHash({ ...base }));
    expect(inputsHash(base)).not.toBe(inputsHash({ ...base, model: "n" }));
    expect(inputsHash(base)).not.toBe(inputsHash({ ...base, taskStartSha: "t" }));
  });
});

describe("execution lock", () => {
  it("allows one executor per repo and fences out a stale one", async () => {
    const a = await ExecutionLock.acquire("repo1", "run-a");
    await expect(ExecutionLock.acquire("repo1", "run-b")).rejects.toBeInstanceOf(LockBusyError);
    expect(a.epoch()).toBe(1);
    await a.release();
    const b = await ExecutionLock.acquire("repo1", "run-b");
    expect(b.epoch()).toBe(2);
    expect(() => a.assertCurrent()).toThrow(FencedOutError);
    const l = await newRun();
    await expect(l.append({ type: "run.resumed" }, a)).rejects.toBeInstanceOf(FencedOutError);
    const ev = await l.append({ type: "run.resumed" }, b);
    expect(ev.epoch).toBe(2);
    await b.release();
  });
});

describe("human decisions", () => {
  async function withCard() {
    const l = await newRun();
    await l.append({
      type: "human.requested",
      data: { cardId: "approval-1", kind: "approval", artifactSha: "abcd1234".padEnd(64, "0") },
    }, HUMAN_WRITER);
    return l;
  }

  it("records a hash-bound decision and treats a repeat as a no-op", async () => {
    const l = await withCard();
    expect(replay(l.events()).status).toBe("waiting");
    const r1 = await decide(l, { decision: "approve", hashPrefix: "abcd", by: "ahsan" });
    expect(r1.kind).toBe("recorded");
    expect(replay(l.events()).openCard).toBeUndefined();
    const r2 = await decide(l, { decision: "approve", hashPrefix: "abcd", by: "ahsan" });
    expect(r2.kind).toBe("repeat");
    expect(l.events().filter((e) => e.type === "human.decided")).toHaveLength(1);
  });

  it("refuses a stale hash, a short prefix, and a reject without reason", async () => {
    const l = await withCard();
    await expect(decide(l, { decision: "approve", hashPrefix: "ffff" })).rejects.toBeInstanceOf(DecisionError);
    await expect(decide(l, { decision: "approve", hashPrefix: "ab" })).rejects.toBeInstanceOf(DecisionError);
    await expect(decide(l, { decision: "reject", hashPrefix: "abcd" })).rejects.toThrow(/reason/);
  });

  it("applies a default decision after the deadline", async () => {
    const l = await newRun();
    await l.append({
      type: "human.requested",
      data: { cardId: "q-1", kind: "question", artifactSha: "e".repeat(64), deadline: "2000-01-01T00:00:00Z", defaultDecision: { answers: {} } },
    }, HUMAN_WRITER);
    expect(await applyExpiredDeadline(l)).toBe(true);
    const s = replay(l.events());
    expect(s.decisions[0]?.by).toBe("default-timeout");
    expect(await applyExpiredDeadline(l)).toBe(false);
  });
});

describe("sinks and caps", () => {
  it("looks up before creating", async () => {
    const l = await newRun();
    let created = 0;
    const existing: string[] = [];
    const sink = {
      kind: "pr", idempotencyKey: "pr:factory/x",
      lookup: async () => (existing[0] ? { externalId: existing[0], value: 1 } : undefined),
      create: async () => { created++; existing.push("PR-1"); return { externalId: "PR-1", value: 1 }; },
    };
    await runSink(l, HUMAN_WRITER, sink);
    const again = await runSink(l, HUMAN_WRITER, sink);
    expect(created).toBe(1);
    expect(again.created).toBe(false);
  });

  it("parks on cost and attempts", async () => {
    const l = await newRun();
    await l.append({ type: "usage", data: { "gen_ai.usage.cost_usd": 11 } }, HUMAN_WRITER);
    expect(checkCaps(replay(l.events()))?.reason).toMatch(/Cost limit/);
    const l2 = await newRun("run-2");
    for (let i = 1; i <= 6; i++) {
      await l2.append({ type: "step.started", key: `implement/TASK-1/${i}` }, HUMAN_WRITER);
      await l2.append({ type: "step.failed", key: `implement/TASK-1/${i}` }, HUMAN_WRITER);
    }
    expect(checkCaps(replay(l2.events()))).toMatchObject({ kind: "attempts", waivable: true, proposal: { extraAttempts: 3 } });
  });
});

describe("cost limits", () => {
  async function run(id: string) {
    const l = Ledger.create(id);
    await l.append({ type: "run.created", data: { mode: "brownfield", project: "p" } }, HUMAN_WRITER);
    return l;
  }
  const spend = (l: Ledger, usd: number) => l.append({ type: "usage", data: { "gen_ai.usage.cost_usd": usd } }, HUMAN_WRITER);
  const complete = async (l: Ledger, step: string, data: Record<string, unknown>) => {
    await l.append({ type: "step.started", key: `${step}/1` }, HUMAN_WRITER);
    await l.append({ type: "step.completed", key: `${step}/1`, data }, HUMAN_WRITER);
  };

  it("before plan: never below the medium $10, even for a bugfix", async () => {
    const l = await run("cap-1");
    await complete(l, "intake", { changeClass: "bugfix" });
    expect(replay(l.events()).info.changeClass).toBe("bugfix");
    await spend(l, 6);
    expect(checkCaps(replay(l.events()))).toBeUndefined();
    await spend(l, 4.5);
    expect(checkCaps(replay(l.events()))).toMatchObject({ kind: "cost", waivable: true, proposal: { costUsd: 20 } });
  });

  it("after plan: spend so far + the size's cap (at least $10)", async () => {
    const l = await run("cap-2");
    await complete(l, "intake", { changeClass: "feature" });
    await spend(l, 4);
    await complete(l, "plan", { complexity: "L" });
    expect(currentCostCap(replay(l.events()))).toBe(24); // $4 + $20
    await spend(l, 19);
    expect(checkCaps(replay(l.events()))).toBeUndefined();
    const l2 = await run("cap-3");
    await spend(l2, 3);
    await complete(l2, "plan", { complexity: "S" });
    expect(currentCostCap(replay(l2.events()))).toBe(13); // $3 + max($5, $10)
  });

  it("a hash-bound waiver raises the limit; it isn't counted as a gate waiver", async () => {
    const l = await run("cap-4");
    await spend(l, 11);
    await l.append({ type: "human.requested", data: { cardId: "cap-x", kind: "cap", artifactSha: "c".repeat(64), proposal: { costUsd: 20 } } }, HUMAN_WRITER);
    await expect(decide(l, { decision: "waive-cap", hashPrefix: "dddd", data: { costUsd: 20 } })).rejects.toThrow(/doesn't match/);
    await decide(l, { decision: "waive-cap", hashPrefix: "cccc", by: "ahsan", data: { costUsd: 20 } });
    const s = replay(l.events());
    expect(s.openCard).toBeUndefined();
    expect(checkCaps(s)).toBeUndefined();
    expect(s.waivers).toBe(0);
  });

  it("waivers, rejections and interruptions still park", async () => {
    const l = await run("cap-5");
    for (let i = 0; i < 2; i++) await l.append({ type: "human.decided", data: { cardId: `a${i}`, decision: "reject", by: "x", artifactSha: "" } }, HUMAN_WRITER);
    expect(checkCaps(replay(l.events()))).toMatchObject({ kind: "rejections", waivable: false });
  });
});
