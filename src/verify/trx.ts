// Parse VSTest TRX files into test results (stack pack for .NET; verify-runner §2.4).
// Test ID format: <project>::<fully qualified name>(<args>).
import { XMLParser } from "fast-xml-parser";
import type { FailureKind } from "../contracts/index.js";
import type { TestResult } from "../contracts/index.js";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  isArray: (name) => ["UnitTest", "UnitTestResult", "Output"].includes(name),
});

export interface TrxParsed {
  results: TestResult[];
  counters: { total: number; executed: number; passed: number; failed: number; notExecuted: number };
  startedAt?: string;
}

/** Classify a failure from its message and stack (verify-runner §2.10 FailureKind). */
export function classifyFailure(message: string, stack = ""): FailureKind {
  const text = `${message}\n${stack}`;
  if (/NotImplementedException|not implemented/i.test(text)) return "not-implemented";
  if (/timed? ?out|TimeoutException|exceeded .*timeout/i.test(message)) return "timeout";
  if (/Npgsql\.NpgsqlException|SocketException|Connection refused|could not connect to server|ECONNREFUSED/i.test(text)) return "infra";
  if (/Xunit\.Sdk\.|Assert\.|AssertionException|AssertFailedException|NUnit\.Framework\.Assert|FluentAssertions|Shouldly|Expected[: ]|Assert\.\w+\(\) Failure/.test(text)) return "assertion";
  return "exception";
}

/** Keep up to 5 frames from project code (not framework frames). */
export function projectFrames(stack: string): string[] {
  return stack.split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at ") && !/\bat (System|Microsoft|Xunit|NUnit|Castle|Moq)\./.test(l))
    .map((l) => l.replace(/ in \/.*?\/(?=[^/]+:line)/, " in "))
    .slice(0, 5);
}

function projectFromStorage(storage: string | undefined, fallback: string): string {
  if (!storage) return fallback;
  const base = storage.split(/[\\/]/).pop() ?? storage;
  return base.replace(/\.(dll|exe)$/i, "");
}

function durationMs(d: string | undefined): number {
  if (!d) return 0;
  const m = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(d);
  if (!m) return 0;
  return Math.round(((+m[1]! * 60 + +m[2]!) * 60 + +m[3]!) * 1000);
}

export function parseTrx(xml: string, projectFallback = "tests"): TrxParsed {
  const doc = parser.parse(xml)?.TestRun;
  if (!doc) throw new Error("Not a TRX file (no TestRun element)");
  const defs = new Map<string, { id: string }>();
  for (const ut of doc.TestDefinitions?.UnitTest ?? []) {
    const tm = ut.TestMethod ?? {};
    const project = projectFromStorage(ut.storage, projectFallback);
    const className: string = tm.className ?? "";
    // className can be "Ns.Class, Assembly, Version=..." in older TRX
    const cls = className.split(",")[0]!.trim();
    const name: string = ut.name ?? tm.name ?? "";
    // Theories: name already includes "(args)"; if name is FQN, use as is
    const fqn = name.startsWith(cls + ".") ? name : cls ? `${cls}.${name}` : name;
    defs.set(ut.id, { id: `${project}::${fqn}` });
  }
  const results: TestResult[] = [];
  for (const r of doc.Results?.UnitTestResult ?? []) {
    const def = defs.get(r.testId);
    const id = def?.id ?? `${projectFallback}::${r.testName}`;
    const outcome = String(r.outcome ?? "");
    const info = r.Output?.[0]?.ErrorInfo ?? {};
    const message = String(info.Message ?? "").trim();
    const stack = String(info.StackTrace ?? "");
    const base = { id, durationMs: durationMs(r.duration) };
    if (outcome === "Passed") results.push({ ...base, outcome: "passed" });
    else if (outcome === "Failed" || outcome === "Error" || outcome === "Aborted") {
      results.push({ ...base, outcome: "failed", failureKind: classifyFailure(message, stack), message: message.slice(0, 2000), frames: projectFrames(stack) });
    } else if (outcome === "Timeout") results.push({ ...base, outcome: "failed", failureKind: "timeout", message: message || "Timed out" });
    else if (outcome === "NotExecuted" || outcome === "Inconclusive") results.push({ ...base, outcome: "skipped", message });
    else results.push({ ...base, outcome: "notRun", message: outcome });
  }
  const c = doc.ResultSummary?.Counters ?? {};
  return {
    results,
    counters: {
      total: +(c.total ?? results.length), executed: +(c.executed ?? 0), passed: +(c.passed ?? 0),
      failed: +(c.failed ?? 0), notExecuted: +(c.notExecuted ?? 0),
    },
    startedAt: doc.Times?.start,
  };
}
