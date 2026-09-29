import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { argsSummary, fmtElapsed, lastActivity, readTrace, Tracer } from "./trace.js";

describe("run trace", () => {
  it("writes both files, masks secrets everywhere, echoes to the console", () => {
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const echoed: string[] = [];
    const t = new Tracer(dir, { echo: (l) => echoed.push(l), putBlob: () => "b".repeat(64) });
    t.setStep("plan", 2);
    t.event("model.turn", "turn 1 with key sk-ant-abcdefghijklmnopqrstuvwxyz0123", { note: "Password=hunter2secret" });
    const raw = readFileSync(join(dir, "trace.jsonl"), "utf8") + readFileSync(join(dir, "run.log"), "utf8");
    expect(raw).not.toContain("sk-ant-abcdefghij");
    expect(raw).not.toContain("hunter2secret");
    expect(readFileSync(join(dir, "run.log"), "utf8")).toMatch(/plan#2 +turn 1 with key «SECRET_1»/);
    expect(echoed).toHaveLength(1);
    expect(readTrace(dir)[0]).toMatchObject({ step: "plan", attempt: 2, kind: "model.turn" });
  });

  it("the heartbeat names the last real activity and doesn't count as activity", () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "trace-"));
    const t = new Tracer(dir);
    t.setStep("implement/TASK-1", 1);
    t.event("agent.tool", "implementer: Bash dotnet build");
    t.startHeartbeat(60_000);
    vi.advanceTimersByTime(3 * 60_000 + 10);
    t.stopHeartbeat();
    vi.useRealTimers();
    const beats = readTrace(dir).filter((e) => e.kind === "heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(2);
    expect(beats[beats.length - 1]!.msg).toMatch(/still waiting on: implementer: Bash dotnet build \(\d min/);
    expect(lastActivity(dir)?.kind).toBe("agent.tool");
  });

  it("formats times and tool arguments briefly", () => {
    expect(fmtElapsed(9_000)).toBe("+9s");
    expect(fmtElapsed(130_000)).toBe("+2m10s");
    expect(argsSummary({ path: "src/Orders/OrderService.cs", start: 10 })).toBe("src/Orders/OrderService.cs");
    expect(argsSummary({ pattern: "x".repeat(200) })).toHaveLength(80);
  });
});
