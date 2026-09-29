import { describe, expect, it } from "vitest";
import { Review, ReviewBody, ReviewFinding } from "../contracts/index.js";
import { DEFAULT_POLICY } from "../gates/policy.js";
import { isBlocking, reviewBlocking } from "../gates/predicates.js";
import type { RunState } from "../ledger/state.js";
import { OWASP_CHECKLIST, prBody, REVIEW_TEMPLATE, reviewStep } from "./deliver.js";

const finding = { id: "R-1", category: "security" as const, file: "src/Api/Orders.cs", line: 12, text: "no [Authorize] on the new endpoint", confidence: 0.9, severity: "low" as const };

describe("review security pass", () => {
  it("a stored review without owasp still parses", () => {
    const { owasp: _, ...old } = { ...finding, owasp: "x" };
    expect(ReviewFinding.parse(old)).toEqual(old);
    expect(ReviewBody.parse({ findings: [old] }).findings[0]!.owasp).toBeUndefined();
    expect(Review.shape.findings.parse([old])).toHaveLength(1);
    expect(ReviewFinding.parse({ ...finding, owasp: "A01 Broken Access Control" }).owasp).toBe("A01 Broken Access Control");
  });

  it("owasp doesn't change what blocks", () => {
    const low = { ...finding, owasp: "A01 Broken Access Control" };
    expect(isBlocking(low, DEFAULT_POLICY)).toBe(false);
    expect(isBlocking({ ...low, severity: "medium" }, DEFAULT_POLICY)).toBe(isBlocking({ ...finding, severity: "medium" }, DEFAULT_POLICY));
    expect(isBlocking({ ...low, severity: "high", confidence: 0.5 }, DEFAULT_POLICY)).toBe(false);
    expect(reviewBlocking.predicate({ review: { findings: [low] }, families: { implementer: "claude", reviewer: "gpt" } }, DEFAULT_POLICY).passed).toBe(true);
  });

  it("the review prompt carries the OWASP checklist", () => {
    expect(REVIEW_TEMPLATE).toContain("You review a finished change before it becomes a pull request.");
    expect(REVIEW_TEMPLATE).toContain(OWASP_CHECKLIST);
    for (const item of ["A01 Broken Access Control", "IDOR", "A03 Injection", "A02 Cryptographic Failures", "A04 Insecure Design", "CORS *", "A06 Vulnerable", "A07 Identification", "deserialization", "A09 Security Logging", "A10 Server-Side Request Forgery"]) {
      expect(OWASP_CHECKLIST).toContain(item);
    }
    expect(OWASP_CHECKLIST).toMatch(/ONLY problems this diff introduces or makes reachable/);
    expect(reviewStep.templateVersion).toBe("2");
  });
});

describe("PR body security line", () => {
  const ctx = { runId: "r1", state: { info: { request: "Add orders", sources: [] }, costUsd: 1.5 } as unknown as RunState };
  const base = {
    spec: { requirements: [{ id: "REQ-1", ears: "The API shall list orders.", acceptance: [{ id: "AC-1.1" }] }] },
    plan: { tasks: [{ id: "TASK-1", title: "List orders", reqs: ["REQ-1"] }] },
    lock: { tests: [{ acId: "AC-1.1", testId: "Orders.Lists" }] },
    run: { results: [{ id: "Orders.Lists", outcome: "passed" }] },
    manifestHash: "abc", commits: [],
  } as unknown as Parameters<typeof prBody>[1];

  it("says nothing was found when there are no security findings", () => {
    const body = prBody(ctx, { ...base, review: { findings: [{ id: "R-1", severity: "low", text: "dup", category: "reuse" }] } });
    expect(body).toContain("- Review: 1 non-blocking findings\n  - R-1 [low] dup\n- Security review (OWASP Top 10): nothing found\n");
  });

  it("lists non-blocking security findings", () => {
    const body = prBody(ctx, { ...base, review: { findings: [{ ...finding, owasp: "A01 Broken Access Control" }, { ...finding, id: "R-2", owasp: undefined }] } });
    expect(body).toContain("- Security review (OWASP Top 10): 2 findings\n  - R-1 A01 Broken Access Control at src/Api/Orders.cs:12\n  - R-2 security at src/Api/Orders.cs:12\n");
    expect(body).toContain("- Review: 2 non-blocking findings");
  });
});
