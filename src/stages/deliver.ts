// review (L, other family) and deliver (D): per-commit secret scan, evidence manifest,
// gated SHA + one manifest-only commit, PR via the forge sink (look up before create).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { userInfo } from "node:os";
import { z } from "zod";
import type { EvidenceManifest, PlanBody, SpecDraft, TestRun } from "../contracts/index.js";
import { ReviewBody } from "../contracts/index.js";
import { scanText } from "../context/secrets.js";
import { secret } from "../config/env.js";
import { failure, runGate } from "../gates/engine.js";
import { noSecrets, reviewBlocking, shaBinding } from "../gates/predicates.js";
import { changedFiles, commitAll, git, gitOut, resetHard } from "../ledger/git.js";
import { runSink } from "../ledger/sinks.js";
import { family } from "../runners/types.js";
import { hashJson } from "../util/hash.js";
import { header, requireOutput, type StepContext, type StepDef, type StepOutcome } from "./framework.js";
import { modelFor } from "./routing.js";
import { S, think } from "./think.js";
import { ensureWorktree } from "./workspace.js";

type Spec = z.infer<typeof SpecDraft>;
type Plan = z.infer<typeof PlanBody>;

const gatedSha = (ctx: Pick<StepContext, "state">) => String(ctx.state.steps.get("integrate")!.data!.commit);

// ---------- review ----------
/** OWASP Top 10 (2021) items that apply to a backend .NET/web diff. */
export const OWASP_CHECKLIST = `Security pass: go through this OWASP Top 10 (2021) checklist for the diff.
- A01 Broken Access Control: a new or changed endpoint without authorization; ids taken from the request without an ownership check (IDOR).
- A02 Cryptographic Failures: weak or unsalted hashing, hard-coded keys or secrets, home-made crypto.
- A03 Injection: SQL built from strings or raw SQL with user input, command or LDAP strings built from input.
- A04 Insecure Design: trusting client input for prices, roles, ids or other values the server should decide.
- A05 Security Misconfiguration: CORS *, debug or developer pages on, detailed errors or stack traces sent to the client.
- A06 Vulnerable and Outdated Components: new or changed dependencies, especially old or unmaintained versions.
- A07 Identification and Authentication Failures: weakened login, token or session checks.
- A08 Software and Data Integrity Failures: unsafe deserialization (e.g. type names from input).
- A09 Security Logging and Monitoring Failures: logging secrets, tokens or personal data; swallowing errors.
- A10 Server-Side Request Forgery: fetching a URL the user supplied.
Report ONLY problems this diff introduces or makes reachable, pointing at changed lines, never pre-existing code. Use category "security" and set owasp to the item, e.g. "A01 Broken Access Control". Use medium or higher only when the problem is reachable through this change; hardening suggestions are low. Mark confidence honestly: below 0.7 when you can't see the whole path.`;

export const REVIEW_TEMPLATE = `You review a finished change before it becomes a pull request. Look for: correctness bugs, mismatches with the acceptance criteria, missing error handling, security problems, needless duplication, and attempts to fake test results (exiting the process, writing report files, patching assertions, skipping tests).
Report only real problems you can point to in the diff: file, line (in the new file), category, severity (critical|high|medium|low), confidence 0..1, one or two sentences. IDs R-1.. Empty list if the change is fine.

${OWASP_CHECKLIST}`;

export const reviewStep: StepDef = {
  key: "review", stage: "review", templateVersion: "2", // 2: OWASP checklist
  inputs: (s) => (s.steps.get("accept")?.status === "completed" ? { integrate: s.steps.get("integrate")!.outputs[0], evidence: s.steps.get("accept")!.outputs[0] } : undefined),
  async run(ctx) {
    const spec = requireOutput<Spec>(ctx.state, ctx.ledger, "specify");
    const intent = requireOutput<{ spans: { id: string; text: string }[] }>(ctx.state, ctx.ledger, "intake");
    const run = requireOutput<TestRun>(ctx.state, ctx.ledger, "integrate");
    const head = gatedSha(ctx);
    const wt = await ensureWorktree(ctx, head);
    let diff = (await git(wt, ["diff", "--no-color", "-U5", ctx.state.info.baseCommit!, head])).stdout;
    if (diff.length > 80_000) diff = diff.slice(0, 80_000) + "\n… (diff truncated; use read_file for the rest)";
    const r = await think(ctx, {
      stage: "review", route: "review", cls: "read-large", budgetTokens: 40000, tools: [], schema: ReviewBody, maxTurns: 4,
      sections: [
        S.template("tpl", REVIEW_TEMPLATE),
        S.artifact("intent", "intent", intent.spans),
        S.artifact("acs", "acceptance-criteria", spec.requirements),
        S.artifact("verification", "verification", { tests: run.results.length, failed: run.results.filter((x) => x.outcome === "failed").map((x) => x.id), flaky: run.results.filter((x) => x.flaky).map((x) => x.id) }),
        { spec: { id: "diff", source: "artifact", trust: "derived", placement: "user" }, content: diff, artifactKind: "diff" },
        S.task("Review the diff."),
      ],
    });
    if (!r.ok) return r.outcome;
    const reviewSha = ctx.ledger.putJson({ header: header(ctx.runId, "review", "review", "", r.model), ...r.output, note: r.note });
    const implementer = modelFor(ctx.project, "implement", 0).model;
    const fam = ctx.ledger.putJson({ implementer: family(implementer), reviewer: family(r.model) });
    const g = await runGate(reviewBlocking, ctx.ledger, ctx.writer, { review: reviewSha, families: fam }, ctx.policy, { step: "review", treeSha: head });
    if (!g.passed) return { kind: "park", reason: `Review found blocking problems: ${(g.failures ?? []).slice(0, 3).map((f) => f.message).join(" | ")}` };
    return { kind: "done", outputs: { review: reviewSha }, data: { findings: r.output.findings.length, note: r.note } };
  },
};

// ---------- deliver ----------
export function prBody(ctx: Pick<StepContext, "state" | "runId">, a: { spec: Spec; plan: Plan; lock: { tests: { acId: string; testId: string }[]; familyNote?: string }; run: TestRun; review: { findings: { id: string; severity: string; text: string; category?: string; owasp?: string; file?: string; line?: number }[]; note?: string }; manifestHash: string; commits: string[] }): string {
  const flaky = a.run.results.filter((r) => r.flaky).map((r) => r.id);
  const security = a.review.findings.filter((f) => f.category === "security");
  return [
    `## What was asked`,
    ...((ctx.state.info.sources ?? []).length ? [`From: ${(ctx.state.info.sources ?? []).map((x) => (x.kind === "jira" ? `[${x.key}](${x.url})` : x.kind === "file" ? x.name : "typed prompt")).join(" + ")}`, ``] : []),
    ...(ctx.state.info.request ?? "").split("\n").map((l) => `> ${l}`),
    ``,
    `## Requirements → tests`,
    ...a.spec.requirements.map((r) => `- **${r.id}** ${r.ears}\n${r.acceptance.map((c) => `  - ${c.id}: \`${a.lock.tests.find((t) => t.acId === c.id)?.testId ?? "manual"}\``).join("\n")}`),
    ``,
    `## Tasks`,
    ...a.plan.tasks.map((t) => `- ${t.id} ${t.title} (${t.reqs.join(", ")})`),
    ``,
    `## Checks the factory ran itself`,
    `- ${a.run.results.length} tests in a sealed container; ${a.run.results.filter((r) => r.outcome === "passed").length} passed; no new failures vs the base branch`,
    `- Acceptance tests were written first, failed on the old code twice, then locked`,
    ...(a.lock.familyNote ? [`- ⚠ ${a.lock.familyNote}`] : []),
    ...(flaky.length ? [`- ⚠ Flaky (passed only on re-run): ${flaky.join(", ")}`] : []),
    `- Review: ${a.review.findings.length} non-blocking findings${a.review.note ? ` (${a.review.note})` : ""}`,
    ...a.review.findings.map((f) => `  - ${f.id} [${f.severity}] ${f.text}`),
    `- Security review (OWASP Top 10): ${security.length ? `${security.length} finding${security.length > 1 ? "s" : ""}` : "nothing found"}`,
    ...security.map((f) => `  - ${f.id} ${f.owasp ?? "security"}${f.file ? ` at ${f.file}:${f.line}` : ""}`),
    ``,
    `Cost: $${ctx.state.costUsd.toFixed(2)} · Run: \`${ctx.runId}\` · Evidence manifest: \`${a.manifestHash}\``,
  ].join("\n");
}

async function githubSink(ctx: StepContext, branch: string, title: string, body: string, draft: boolean) {
  const forge = ctx.project.forge!;
  const token = secret(forge.tokenEnv);
  if (!token) throw new Error(`${forge.tokenEnv} is missing in ~/.factory/.env`);
  const api = `https://api.github.com/repos/${forge.repo}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "ai-factory" };
  const [owner] = forge.repo.split("/");
  return runSink(ctx.ledger, ctx.writer, {
    kind: "pr", idempotencyKey: `pr:${branch}`,
    lookup: async () => {
      const res = await fetch(`${api}/pulls?head=${owner}:${encodeURIComponent(branch)}&state=all`, { headers });
      if (!res.ok) throw new Error(`GitHub lookup failed: ${res.status}`);
      const prs = (await res.json()) as { html_url: string; number: number }[];
      return prs[0] ? { externalId: prs[0].html_url, value: prs[0].number } : undefined;
    },
    create: async () => {
      const base = ctx.project.baseBranch;
      const res = await fetch(`${api}/pulls`, { method: "POST", headers, body: JSON.stringify({ title, head: branch, base, body, draft }) });
      if (!res.ok) throw new Error(`GitHub PR create failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      const pr = (await res.json()) as { html_url: string; number: number };
      return { externalId: pr.html_url, value: pr.number };
    },
  });
}

export const deliverStep: StepDef = {
  key: "deliver", stage: "deliver", templateVersion: "1", coding: true,
  inputs: (s) => (s.steps.get("review")?.status === "completed" ? { review: s.steps.get("review")!.outputs[0], gated: s.steps.get("integrate")!.data?.commit } : undefined),
  async run(ctx): Promise<StepOutcome> {
    const base = ctx.state.info.baseCommit!;
    const gated = gatedSha(ctx);
    const wt = await ensureWorktree(ctx, gated);
    await resetHard(wt, gated);

    // secret scan of every commit in the branch
    const commits = (await gitOut(wt, ["rev-list", "--reverse", `${base}..${gated}`])).split("\n").filter(Boolean);
    const hits = [];
    for (const c of commits) {
      const patch = (await git(wt, ["show", "--no-color", "-U0", "--format=", c])).stdout;
      let file = "";
      for (const line of patch.split("\n")) {
        if (line.startsWith("+++ b/")) file = line.slice(6);
        else if (line.startsWith("+") && !line.startsWith("+++")) hits.push(...scanText(file, line.slice(1)).map((h) => ({ ...h, line: 0 })));
      }
    }
    const scan = ctx.ledger.putJson({ kind: "secrets", commit: gated, hits });
    const sg = await runGate(noSecrets, ctx.ledger, ctx.writer, { scan }, ctx.policy, { step: "deliver", treeSha: gated });
    if (!sg.passed) return { kind: "park", reason: `Secret scan found possible secrets in the branch: ${sg.details}` };

    // evidence manifest from the ledger
    const artifacts = [...ctx.state.steps.values()].filter((r) => r.status === "completed").flatMap((r) => r.outputs.map((sha) => ({ kind: "blob" as const, path: r.step, sha })));
    const lock = requireOutput<{ tests: { acId: string; testId: string }[]; lock: { file: string; sha: string }[]; familyNote?: string }>(ctx.state, ctx.ledger, "author-tests");
    const manifest: EvidenceManifest = {
      header: header(ctx.runId, "evidence-manifest", "deliver", hashJson(artifacts)) as EvidenceManifest["header"],
      artifacts, locks: lock.lock,
      approvals: ctx.state.decisions.filter((d) => d.decision === "approve").map((d) => ({
        gate: d.cardId, artifactSha: d.artifactSha, osUser: d.by, gitIdentity: userInfo().username,
        riskNote: String((d as unknown as { note?: string }).note ?? ""), at: new Date().toISOString(),
      })),
      gatedTreeSha: gated, waivers: [], unlocks: [],
      configFingerprint: hashJson({ project: ctx.project, policy: ctx.policy }),
      versions: (ctx.state.info.versions ?? {}) as Record<string, string>,
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestHash = ctx.ledger.putArtifact(manifestJson);
    mkdirSync(join(wt, ".factory"), { recursive: true });
    writeFileSync(join(wt, ".factory", "evidence-manifest.json"), manifestJson);
    const head = await commitAll(wt, `factory: evidence manifest for ${ctx.runId}`);
    const parent = await gitOut(wt, ["rev-parse", `${head}^`]);
    const changed = (await changedFiles(wt, parent, head)).map((c) => c.path);
    const pushed = ctx.ledger.putJson({ headParent: parent, manifestOnly: changed.length === 1 && changed[0] === ".factory/evidence-manifest.json", changed });
    const bg = await runGate(shaBinding, ctx.ledger, ctx.writer, { pushed, gatedSha: ctx.ledger.putJson(gated) }, ctx.policy, { step: "deliver", treeSha: head });
    if (!bg.passed) return { kind: "park", reason: bg.details };

    const spec = requireOutput<Spec>(ctx.state, ctx.ledger, "specify");
    const plan = requireOutput<Plan>(ctx.state, ctx.ledger, "plan");
    const body = prBody(ctx, { spec, plan, lock, run: requireOutput<TestRun>(ctx.state, ctx.ledger, "integrate"), review: requireOutput(ctx.state, ctx.ledger, "review"), manifestHash, commits });
    const title = `factory: ${spec.requirements[0]?.ears.slice(0, 60) ?? ctx.runId}`;
    const bodySha = ctx.ledger.putArtifact(body);
    ctx.ledger.writeCard(`pr-${ctx.runId}`, `# ${title}\n\n${body}`);
    const branch = ctx.state.workspace!.branch;

    if (!ctx.project.forge) {
      ctx.log(`deliver: no forge configured; branch ${branch} is ready locally (PR text saved)`);
      return { kind: "done", outputs: { manifest: manifestHash, prBody: bodySha }, treeSha: head, data: { local: true, branch, head, manifestHash } };
    }
    // push exactly: gated SHA + manifest commit
    const token = secret(ctx.project.forge.tokenEnv);
    if (!token) return { kind: "park", reason: `${ctx.project.forge.tokenEnv} is missing in ~/.factory/.env` };
    const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
    await git(wt, ["-c", `http.extraHeader=Authorization: Basic ${auth}`, "push", `https://github.com/${ctx.project.forge.repo}.git`, `${head}:refs/heads/${branch}`]);
    const pr = await githubSink(ctx, branch, title, body, false).catch((e: Error) => { throw new Error(e.message.replaceAll(token, "«SECRET»")); });
    return { kind: "done", outputs: { manifest: manifestHash, prBody: bodySha }, treeSha: head, data: { local: false, branch, head, prUrl: pr.externalId, manifestHash } };
  },
};

export { failure };
