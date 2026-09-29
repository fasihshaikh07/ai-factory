// Where the design toolkit reads files from: a folder on disk, or a commit in a git repo.
// Git reads use the factory's hardened settings (no hooks, no filters, no user config).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { hardenedEnv } from "../ledger/git.js";

export interface FileSource {
  /** Repo-relative POSIX paths of every file (build output and dependencies skipped). */
  list(): string[];
  /** File text, or undefined when it doesn't exist. */
  read(path: string): string | undefined;
}

export const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", ".turbo", ".vercel", ".contentlayer"]);

const HARDENING = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=never"];

/** Read-only git call with the factory's hardening. Throws on a non-zero exit. */
export function gitSync(repo: string, args: string[]): string {
  return execFileSync("git", [...HARDENING, "-C", repo, ...args], {
    encoding: "utf8", env: hardenedEnv(), maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
}

export function dirSource(root: string): FileSource {
  let files: string[] | undefined;
  return {
    list() {
      if (files) return files;
      const out: string[] = [];
      const walk = (dir: string) => {
        let entries;
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (SKIP_DIRS.has(e.name)) continue;
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.isFile()) out.push(relative(root, p).split("\\").join("/"));
        }
      };
      walk(root);
      files = out.sort();
      return files;
    },
    read(path) {
      const p = join(root, path);
      if (!existsSync(p)) return undefined;
      try { return readFileSync(p, "utf8"); } catch { return undefined; }
    },
  };
}

/** Files at a commit, without checking anything out. */
export function gitSource(repo: string, commit: string): FileSource {
  let files: string[] | undefined;
  const cache = new Map<string, string | undefined>();
  return {
    list() {
      files ??= gitSync(repo, ["ls-tree", "-r", "--name-only", "-z", commit]).split("\0").filter(Boolean)
        .filter((f) => !f.split("/").some((seg) => SKIP_DIRS.has(seg))).sort();
      return files;
    },
    read(path) {
      if (cache.has(path)) return cache.get(path);
      let text: string | undefined;
      try { text = gitSync(repo, ["show", `${commit}:${path}`]); } catch { text = undefined; }
      cache.set(path, text);
      return text;
    },
  };
}
