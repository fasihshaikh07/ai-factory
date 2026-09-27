import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** ~/.factory, overridable with FACTORY_HOME (tests use a temp dir). */
export function factoryHome(): string {
  return resolve(process.env.FACTORY_HOME ?? join(homedir(), ".factory"));
}

export const paths = {
  ledger: (runId: string) => join(factoryHome(), "ledger", runId),
  locks: () => join(factoryHome(), "locks"),
  worktrees: () => join(factoryHome(), "wt"),
  repos: () => join(factoryHome(), "repos"),
  envFile: () => join(factoryHome(), ".env"),
};

/**
 * run-manager §2.1: Linux/macOS, or Windows via WSL2 only. Never a path on a
 * Windows drive (/mnt/c): fsync and file locking are unreliable there.
 */
export function assertSupportedPath(p: string): void {
  if (process.platform === "win32") {
    throw new Error("The factory runs inside WSL2 on Windows, not as a native Windows process.");
  }
  if (/^\/mnt\/[a-z](\/|$)/i.test(resolve(p))) {
    throw new Error(`Path ${p} is on a Windows drive. Move it into the Linux filesystem (e.g. ~/code).`);
  }
}
