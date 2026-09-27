// Per-run snapshot (locked room), worktree (coding) and container runtime access.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSnapshot, snapshotDir, type Snapshot } from "../context/snapshot.js";
import { Redactor } from "../context/secrets.js";
import { RepoTools } from "../context/tools.js";
import { addWorktree } from "../ledger/git.js";
import { paths } from "../util/paths.js";
import { DockerCli, type ContainerRuntime } from "../verify/runtime.js";
import type { StepContext } from "./framework.js";

export function snapshotFor(ctx: Pick<StepContext, "runId" | "state" | "project">): Snapshot {
  const { repoPath, baseCommit } = ctx.state.info;
  if (!repoPath || !baseCommit) throw new Error("Run has no repo");
  return createSnapshot(repoPath, baseCommit, snapshotDir(ctx.runId, baseCommit), ctx.project.noGo);
}

export function toolsFor(ctx: Pick<StepContext, "runId" | "state" | "project">): RepoTools {
  return new RepoTools(snapshotFor(ctx), new Redactor(), ctx.project.noGo);
}

/** Short worktree path (long-path limits), created once per run by the core. */
export async function ensureWorktree(ctx: StepContext, base: string): Promise<string> {
  if (ctx.state.workspace && existsSync(ctx.state.workspace.path)) return ctx.state.workspace.path;
  const short = ctx.runId.slice(-4) + "-" + ctx.runId.slice(0, 8);
  const wt = join(paths.worktrees(), short);
  const branch = `factory/${ctx.runId}`;
  await addWorktree(ctx.state.info.repoPath!, wt, branch, base, ctx.runId);
  await ctx.ledger.append({ type: "workspace.created", data: { path: wt, branch } }, ctx.writer);
  ctx.state.workspace = { path: wt, branch };
  return wt;
}

let rt: ContainerRuntime | undefined;
export function runtime(): ContainerRuntime {
  rt ??= new DockerCli();
  return rt;
}
export function setRuntime(r: ContainerRuntime): void {
  rt = r;
}
