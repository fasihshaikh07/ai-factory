// The executor (run-manager §2.3, §2.5, §2.9): replay → next step → run → record → repeat,
// until a human card, a park, delivery, or a stop/pause request. One executor per repo.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Failure } from "../contracts/index.js";
import { loadProject, type ProjectConfig } from "../config/project.js";
import { DEFAULT_POLICY, mergePolicy, type Policy } from "../gates/policy.js";
import { DEFAULT_LADDER, nextOnFailure, type AttemptRecord, type LadderAction } from "../gates/ladder.js";
import { checkCaps } from "../ledger/caps.js";
import { ExecutionLock, LockBusyError } from "../ledger/exec-lock.js";
import { resolveRef } from "../ledger/git.js";
import { applyExpiredDeadline } from "../ledger/human.js";
import { HUMAN_WRITER, Ledger } from "../ledger/ledger.js";
import { canSkip, eventKey, inputsHash, replay, splitKey, type RunState } from "../ledger/state.js";
import { assertSupportedPath } from "../util/paths.js";
import { sha256 } from "../util/hash.js";
import { REPO_ROOT } from "../runners/netinfra.js";
import { setPrice } from "../runners/pricing.js";
import type { StepContext, StepDef, StepOutcome } from "./framework.js";
import { brownfieldSteps } from "./modes.js";
import { availableRungs, routeFor } from "./routing.js";
import { runtime } from "./workspace.js";

export type Log = (msg: string) => void;

export function policyFor(project: ProjectConfig): Policy {
  return mergePolicy(DEFAULT_POLICY, project.policy as Partial<Policy>);
}

function versions(): Record<string, string> {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string; dependencies: Record<string, string> };
  return { factory: pkg.version, node: process.version, "mode:brownfield": "1", ...Object.fromEntries(Object.entries(pkg.dependencies).filter(([k]) => /anthropic|openai|zod/.test(k))) };
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-").slice(0, 30) || "run";
}

export function newRunId(request: string, now = new Date()): string {
  const d = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `${d}-${slug(request)}-${randomBytes(2).toString("hex")}`;
}

/** `factory start`: create the ledger. Execution happens in `execute`. */
export async function createRun(request: string, projectName: string, operator: string): Promise<string> {
  const project = loadProject(projectName);
  assertSupportedPath(project.repo);
  const baseCommit = await resolveRef(project.repo, project.baseBranch);
  const runId = newRunId(request);
  const ledger = Ledger.create(runId);
  const requestSha = ledger.putArtifact(request);
  await ledger.append({
    type: "run.created",
    data: {
      mode: "brownfield", project: project.project, repoPath: project.repo, repoId: project.project,
      baseRef: project.baseBranch, baseCommit, request, requestSha, operator, versions: versions(),
    },
  }, HUMAN_WRITER);
  return runId;
}

export type NextStep = { kind: "run"; step: StepDef; hash: string } | { kind: "done" } | { kind: "blocked"; step: string };

/** Pure: the first step whose recorded inputsHash doesn't match its current inputs. */
export function next(state: RunState, ledger: Ledger, project: ProjectConfig): NextStep {
  for (const step of brownfieldSteps(state)) {
    const inp = step.inputs(state, ledger);
    if (!inp) return { kind: "blocked", step: step.key };
    let model: string | undefined;
    try { model = routeFor(project, step.stage).model; } catch { model = undefined; }
    const hash = inputsHash({ inputs: [JSON.stringify(inp)], stageDef: step.key, templateVersion: step.templateVersion, model, taskStartSha: step.coding ? String((inp as { taskStartSha?: string }).taskStartSha ?? "") : undefined });
    if (canSkip(state, step.key, hash)) continue;
    return { kind: "run", step, hash };
  }
  return { kind: "done" };
}

/** Failed attempts of a step since it last completed (a changed input starts a fresh ladder). */
function attemptHistory(ledger: Ledger, step: string): AttemptRecord[] {
  const evs = ledger.events().filter((e) => e.key && splitKey(e.key).step === step);
  const lastDone = Math.max(-1, ...evs.filter((e) => e.type === "step.completed").map((e) => e.seq));
  return evs.filter((e) => e.type === "step.failed" && e.seq > lastDone && !(e.data as { parked?: boolean })?.parked)
    .map((e) => e.data as unknown as AttemptRecord);
}

export interface ExecuteResult { status: string; message: string }

export async function execute(runId: string, log: Log = () => undefined): Promise<ExecuteResult> {
  const ledger = Ledger.open(runId);
  let state = replay(ledger.events());
  const project = loadProject(state.info.project);
  const policy = policyFor(project);
  for (const [model, price] of Object.entries(project.prices)) setPrice(model, price);
  await applyExpiredDeadline(ledger);

  let lock: ExecutionLock;
  try {
    lock = await ExecutionLock.acquire(state.info.repoId ?? `run:${runId}`, runId, { onCompromised: () => log("execution lock lost; stopping") });
  } catch (e) {
    if (e instanceof LockBusyError) return { status: "queued", message: e.message };
    throw e;
  }
  const writer = lock;
  try {
    state = replay(ledger.events());
    // crash recovery: an unfinished step becomes interrupted; its containers are removed
    if (state.inFlight) {
      const { step, attempt } = state.inFlight;
      log(`resuming: ${step} attempt ${attempt} was interrupted`);
      try {
        const rt = runtime();
        for (const c of await rt.listByLabel("factory.run", runId)) { await rt.stop(c.id, 2); await rt.remove(c.id); }
      } catch { /* no runtime available: nothing to clean */ }
      await ledger.append({ type: "step.interrupted", key: eventKey(step, attempt) }, writer);
    }
    if (state.status === "parked" || state.status === "paused") await ledger.append({ type: "run.resumed" }, writer);

    for (;;) {
      state = replay(ledger.events());
      if (state.flags.stopRequested) { await ledger.append({ type: "run.stopped" }, writer); return { status: "stopped", message: "Stopped." }; }
      if (state.flags.pauseRequested) { await ledger.append({ type: "run.paused" }, writer); return { status: "paused", message: "Paused." }; }
      if (typeof state.status === "object" || state.status === "delivered") return { status: String(typeof state.status === "object" ? `closed: ${state.status.closed}` : state.status), message: "Nothing to do." };
      if (state.openCard) return { status: "waiting", message: `Waiting for you: factory show-card ${runId}` };
      const cap = checkCaps(state);
      if (cap) { await ledger.append({ type: "run.parked", data: { reason: cap } }, writer); return { status: "parked", message: cap }; }

      const n = next(state, ledger, project);
      if (n.kind === "done") return { status: String(state.status), message: "All steps done." };
      if (n.kind === "blocked") throw new Error(`Step ${n.step} isn't ready but nothing before it is pending (bug)`);

      const rec = state.steps.get(n.step.key);
      const attempt = (rec?.lastAttempt ?? 0) + 1;
      const history = attemptHistory(ledger, n.step.key);
      const lastFail = [...ledger.events()].reverse().find((e) => e.type === "step.failed" && e.key && splitKey(e.key).step === n.step.key);
      const rung = history.length ? Number((lastFail?.data as { nextRung?: number } | undefined)?.nextRung ?? 0) : 0;
      const priorFailures: Failure[] = history.length && lastFail?.outputs?.[0] ? ledger.getJson<Failure[]>(lastFail.outputs[0]) : [];
      const key = eventKey(n.step.key, attempt);
      await ledger.append({ type: "step.started", key, inputsHash: n.hash, data: { rung } }, writer);
      log(`▶ ${n.step.key} (attempt ${attempt}${rung ? `, rung ${rung}` : ""})`);

      const ctx: StepContext = {
        runId, ledger, writer, state, project, policy, attempt, rung, priorFailures, log,
        usage: async (u) => {
          await ledger.append({ type: "usage", key, data: {
            "gen_ai.request.model": u.model, "gen_ai.usage.input_tokens": u.inputTokens, "gen_ai.usage.output_tokens": u.outputTokens,
            "gen_ai.usage.cache_read_tokens": u.cacheRead, "gen_ai.usage.cache_write_tokens": u.cacheWrite, "gen_ai.usage.cost_usd": u.estUsd,
          } }, writer);
        },
      };
      let outcome: StepOutcome;
      try {
        outcome = await n.step.run(ctx);
      } catch (e) {
        const msg = (e as Error).message;
        log(`  error: ${msg}`);
        outcome = { kind: "fail", category: /rate limit|overloaded|529|429/i.test(msg) ? "rate-limit" : "other", failures: [{ check: "exception", message: msg.slice(0, 1000), frames: [] }], signature: `exception:${msg.slice(0, 120)}` };
      }

      switch (outcome.kind) {
        case "done": {
          const named = outcome.outputs;
          const treeSha = outcome.treeSha && /^[0-9a-f]{40}$/.test(outcome.treeSha) ? outcome.treeSha : undefined;
          await ledger.append({ type: "step.completed", key, inputsHash: n.hash, treeSha, outputs: Object.values(named), data: { ...(outcome.data ?? {}), named } }, writer);
          log(`✓ ${n.step.key}`);
          if (n.step.key === "deliver") {
            await ledger.append({ type: "run.delivered", data: outcome.data ?? {} }, writer);
            const d = outcome.data as { local?: boolean; branch?: string; prUrl?: string };
            return { status: "delivered", message: d.local ? `Ready locally on branch ${d.branch}. PR text: factory show-card ${runId} --pr` : `PR opened: ${d.prUrl}` };
          }
          break;
        }
        case "wait": {
          const c = outcome.card;
          ledger.writeCard(c.cardId, c.markdown);
          await ledger.append({ type: "step.interrupted", key, data: { reason: "waiting" } }, writer);
          await ledger.append({ type: "human.requested", data: { ...(c.extra ?? {}), cardId: c.cardId, kind: c.kind, artifactSha: c.artifactSha, step: n.step.key, deadline: c.deadline, defaultDecision: c.defaultDecision } }, writer);
          return { status: "waiting", message: `A card needs you: factory show-card ${runId}` };
        }
        case "park":
          await ledger.append({ type: "step.failed", key, data: { category: "other", signature: "park", rung, parked: true } }, writer);
          await ledger.append({ type: "run.parked", data: { reason: outcome.reason, step: n.step.key } }, writer);
          return { status: "parked", message: outcome.reason };
        case "close":
          await ledger.append({ type: "step.failed", key, data: { category: "other", signature: outcome.reason, rung } }, writer);
          await ledger.append({ type: "run.closed", data: { reason: outcome.reason } }, writer);
          return { status: `closed: ${outcome.reason}`, message: outcome.reason };
        case "fail": {
          const rec2: AttemptRecord = { category: outcome.category, signature: outcome.signature ?? sha256(JSON.stringify(outcome.failures)).slice(0, 16), diffSha: outcome.diffSha, rung, lockedFailedIds: outcome.lockedFailedIds };
          const backoffSpent = history.reduce((n2, h) => n2 + Number((h as { waitMs?: number }).waitMs ?? 0), 0);
          const action: LadderAction = nextOnFailure([...history, rec2], {
            ...DEFAULT_LADDER, availableRungs: availableRungs(project, n.step.stage, policy.localOnly), backoffSpentMs: backoffSpent, a5Done: new Set(),
          });
          const failuresSha = ledger.putJson(outcome.failures.slice(0, 20));
          await ledger.append({
            type: "step.failed", key, outputs: [failuresSha],
            data: { ...rec2, action: action.action, nextRung: action.action === "retry" ? action.rung : rung, waitMs: action.action === "backoff" ? action.waitMs : 0, reason: action.reason },
          }, writer);
          log(`✗ ${n.step.key}: ${outcome.failures.slice(0, 2).map((f) => f.message).join("; ").slice(0, 300)} → ${action.action}`);
          if (action.action === "park") { await ledger.append({ type: "run.parked", data: { reason: `${n.step.key}: ${action.reason}`, step: n.step.key } }, writer); return { status: "parked", message: `${n.step.key}: ${action.reason}. Last failure: ${outcome.failures[0]?.message ?? ""}` }; }
          if (action.action === "a5-check") {
            const reason = `Locked tests ${action.testIds.join(", ")} failed twice. Either the code or the test is wrong; the test-defect check and unlock card aren't built yet, so a human needs to look.`;
            await ledger.append({ type: "run.parked", data: { reason, step: n.step.key } }, writer);
            return { status: "parked", message: reason };
          }
          if (action.action === "backoff") { log(`  waiting ${Math.round(action.waitMs / 1000)}s (rate limit)`); await new Promise((r) => setTimeout(r, action.waitMs)); }
          break;
        }
      }
    }
  } finally {
    await lock.release();
  }
}
