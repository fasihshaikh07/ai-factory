// Hardened host git (run-manager §2.10): no hooks, no fsmonitor, no user/system config,
// so no filter drivers (LFS etc.) and no repo code ever runs on the host.
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const HARDENING = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "core.fsmonitor=false",
  "-c", "protocol.file.allow=never",
  "-c", "commit.gpgSign=false",
];

const IDENTITY = { name: "AI Factory", email: "factory@localhost" };

export interface GitResult { stdout: string; stderr: string }

export class GitError extends Error {
  constructor(readonly args: string[], readonly stderr: string, readonly code: number | undefined) {
    super(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  }
}

export function hardenedEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: IDENTITY.name,
    GIT_AUTHOR_EMAIL: IDENTITY.email,
    GIT_COMMITTER_NAME: IDENTITY.name,
    GIT_COMMITTER_EMAIL: IDENTITY.email,
    ...extra,
  };
  return env;
}

export async function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): Promise<GitResult> {
  const full = [...HARDENING, ...args];
  try {
    const { stdout, stderr } = await exec("git", full, {
      cwd, env: hardenedEnv(opts.env), maxBuffer: 256 * 1024 * 1024,
    });
    return { stdout, stderr };
  } catch (e) {
    const err = e as { stderr?: string; code?: number };
    throw new GitError(args, err.stderr ?? String(e), err.code);
  }
}

export async function gitOut(cwd: string, args: string[]): Promise<string> {
  return (await git(cwd, args)).stdout.trim();
}

export async function headSha(cwd: string): Promise<string> {
  return gitOut(cwd, ["rev-parse", "HEAD"]);
}

export async function resolveRef(cwd: string, ref: string): Promise<string> {
  return gitOut(cwd, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

/** Refusals checked before a repo is used (run-manager §2.10). */
export async function repoRefusals(repo: string): Promise<{ code: string; reason: string }[]> {
  const out: { code: string; reason: string }[] = [];
  if (existsSync(join(repo, ".gitmodules"))) out.push({ code: "submodules", reason: "Repos with submodules aren't supported yet." });
  const attrs = await git(repo, ["ls-files", "-z", "--", ".gitattributes", "**/.gitattributes"]).catch(() => ({ stdout: "" }));
  if (attrs.stdout) {
    const lfs = await git(repo, ["grep", "-l", "filter=lfs", "HEAD", "--", ".gitattributes", "**/.gitattributes"]).catch(() => ({ stdout: "" }));
    if (lfs.stdout.trim()) out.push({ code: "lfs", reason: "Repos using Git LFS aren't supported yet." });
  }
  return out;
}

/** Create the run's worktree on a new branch and lock it (run-manager §2.10). */
export async function addWorktree(repo: string, wtPath: string, branch: string, base: string, runId: string): Promise<void> {
  mkdirSync(join(wtPath, ".."), { recursive: true });
  await git(repo, ["worktree", "add", "-b", branch, wtPath, base]);
  await git(repo, ["worktree", "lock", "--reason", `factory run ${runId}`, wtPath]);
}

export async function removeWorktree(repo: string, wtPath: string): Promise<void> {
  await git(repo, ["worktree", "unlock", wtPath]).catch(() => undefined);
  await git(repo, ["worktree", "remove", "--force", wtPath]);
}

/** Stage everything and commit (even when empty, so every attempt has a tree SHA). */
export async function commitAll(wt: string, message: string): Promise<string> {
  await git(wt, ["add", "-A"]);
  await git(wt, ["commit", "--no-verify", "--allow-empty", "-m", message]);
  return headSha(wt);
}

export async function resetHard(wt: string, sha: string): Promise<void> {
  await git(wt, ["reset", "--hard", sha]);
  await git(wt, ["clean", "-fdx"]);
}

/** Diff from `from` to the working tree, untracked files included (run-manager §2.5). */
export async function diffIncludingUntracked(wt: string, from: string): Promise<string> {
  await git(wt, ["add", "-A", "--intent-to-add"]);
  const { stdout } = await git(wt, ["diff", "--binary", from]);
  return stdout;
}

export async function changedFiles(wt: string, from: string, to = "HEAD"): Promise<{ status: string; path: string }[]> {
  const out = await gitOut(wt, ["diff", "--name-status", "--no-renames", from, to]);
  if (!out) return [];
  return out.split("\n").map((l) => {
    const [status, ...rest] = l.split("\t");
    return { status: status!, path: rest.join("\t") };
  });
}

export async function treeSha(wt: string, commit = "HEAD"): Promise<string> {
  return gitOut(wt, ["rev-parse", `${commit}^{tree}`]);
}
