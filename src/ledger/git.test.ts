import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addWorktree, changedFiles, commitAll, diffIncludingUntracked, git, headSha, removeWorktree, repoRefusals, resetHard } from "./git.js";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "factory-git-"));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir, env });
  writeFileSync(join(dir, "a.txt"), "one\n");
  execFileSync("git", ["add", "."], { cwd: dir, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: dir, env });
  return dir;
}

describe("hardened git", () => {
  it("never runs repo hooks", async () => {
    const repo = makeRepo();
    const marker = join(repo, "HOOK_RAN");
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, `#!/bin/sh\ntouch ${marker}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, "b.txt"), "two\n");
    await commitAll(repo, "b");
    expect(existsSync(marker)).toBe(false);
  });

  it("creates a worktree, commits, diffs, resets and removes it", async () => {
    const repo = makeRepo();
    const base = await headSha(repo);
    const wt = join(mkdtempSync(join(tmpdir(), "factory-wt-")), "w1");
    await addWorktree(repo, wt, "factory/run-1", base, "run-1");
    writeFileSync(join(wt, "new.txt"), "x\n");
    const diff = await diffIncludingUntracked(wt, base);
    expect(diff).toContain("new.txt");
    const sha = await commitAll(wt, "task");
    expect(sha).not.toBe(base);
    expect(await changedFiles(wt, base)).toEqual([{ status: "A", path: "new.txt" }]);
    await resetHard(wt, base);
    expect(existsSync(join(wt, "new.txt"))).toBe(false);
    await removeWorktree(repo, wt);
    expect(existsSync(wt)).toBe(false);
    const branches = (await git(repo, ["branch", "--list", "factory/*"])).stdout;
    expect(branches).toContain("factory/run-1");
  });

  it("refuses submodules", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, ".gitmodules"), "");
    expect((await repoRefusals(repo)).map((r) => r.code)).toContain("submodules");
  });
});
