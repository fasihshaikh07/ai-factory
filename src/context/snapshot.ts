// Tracked-files snapshot at the run's base commit (context-builder §2.2): locked-room
// tools read this, never the developer's checkout with its live .env.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { isSecretPath } from "../gates/protected.js";
import { copyTree } from "../verify/dotnet.js";
import { factoryHome } from "../util/paths.js";

export interface Snapshot { root: string; commit: string; files: string[] }

export function snapshotDir(runId: string, commit: string): string {
  return join(factoryHome(), "snapshots", runId, commit.slice(0, 12));
}

/** Copy tracked files at `commit`, then delete secret paths and no-go globs. */
export function createSnapshot(repo: string, commit: string, dest: string, noGo: string[] = []): Snapshot {
  if (!existsSync(dest)) {
    copyTree(repo, commit, dest);
    for (const f of listFiles(dest)) if (isSecretPath(f, noGo)) rmSync(join(dest, f), { force: true });
  }
  return { root: dest, commit, files: listFiles(dest) };
}

export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === ".git" || e.name === "node_modules" || e.name === "bin" || e.name === "obj") continue;
        walk(p);
      } else if (e.isFile()) out.push(relative(root, p).split("\\").join("/"));
    }
  };
  walk(root);
  return out.sort();
}

export function fileSize(root: string, rel: string): number {
  return statSync(join(root, rel)).size;
}
