// ClaudeAgentRunner (adapters.md; context-builder §2.9): the Claude Agent SDK inside container A.
// Container A gets the worktree files only (the .git link file is masked), agent instruction
// files masked, restored packages read-only, the agent env template (dummy values), and a network
// that reaches only the factory's API proxy.
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { toJsonSchema } from "../contracts/index.js";
import { AGENT_FILE_GLOBS, CONFIG_INTEGRITY_GLOBS, LOCK_SET_GLOBS } from "../gates/protected.js";
import { listFiles } from "../context/snapshot.js";
import { matchesAny } from "../util/glob.js";
import { factoryHome } from "../util/paths.js";
import type { ContainerRuntime, Mount } from "../verify/runtime.js";
import { stopAndRemove } from "../verify/runtime.js";
import { AGENT_IMAGE, AGENT_NET, API_BASE_URL } from "./netinfra.js";
import { emptyUsage, type Job, type Result, type Runner } from "./types.js";

export interface AgentJobExtras {
  runId: string;
  key: string;
  /** globs the agent may edit (task file scope); empty = anywhere except protected */
  fileScope: string[];
  /** locked test files + declared-extra protected paths */
  lockedFiles: string[];
  extraProtected: string[];
  /** per-run restored NuGet folder, mounted read-only */
  packagesDir?: string;
  agentEnv: Record<string, string>;
  onContainer?: (id: string) => Promise<void>;
  onRemoved?: (id: string) => Promise<void>;
}

export interface AgentOut {
  status: string;
  output?: unknown;
  error?: string;
  instructionsLoaded: string[];
  deniedEdits: string[];
  usage: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  costUsd: number;
  turns: number;
  sessionId?: string;
}

/** Masks: empty read-only files/dirs over agent instruction files at any depth. */
export function agentFileMasks(worktree: string): { files: string[]; dirs: string[] } {
  const files: string[] = [], dirs = new Set<string>();
  for (const f of listFiles(worktree)) {
    if (!matchesAny(f, AGENT_FILE_GLOBS)) continue;
    const parts = f.split("/");
    const i = parts.findIndex((p) => /^\.(claude|codex|cursor)$/.test(p));
    if (i >= 0 && i < parts.length - 1) dirs.add(parts.slice(0, i + 1).join("/"));
    else if (f === ".github/instructions" || f.startsWith(".github/instructions/")) dirs.add(".github/instructions");
    else files.push(f);
  }
  return { files, dirs: [...dirs] };
}

export class ClaudeAgentRunner implements Runner {
  readonly kind = "claude-agent" as const;
  constructor(private readonly rt: ContainerRuntime, private readonly extras: AgentJobExtras) {}

  async run<T>(job: Job<T>): Promise<Result<T>> {
    if (!job.workdir) throw new Error("ClaudeAgentRunner needs the worktree");
    const started = Date.now();
    const x = this.extras;
    const jobDir = join(factoryHome(), "tmp", x.runId, `agent-${randomBytes(4).toString("hex")}`);
    const outDir = join(jobDir, "out");
    const emptyDir = join(jobDir, "empty-dir");
    const emptyFile = join(jobDir, "empty-file");
    mkdirSync(outDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(emptyFile, "");
    writeFileSync(join(jobDir, "in.json"), JSON.stringify({
      model: job.model,
      effort: job.effort ?? "high",
      maxTurns: job.limits.maxTurns,
      maxUsd: job.limits.maxUsd,
      system: job.pack.system,
      task: job.pack.user,
      schema: toJsonSchema(job.schema),
      fileScope: x.fileScope,
      protectedGlobs: [...LOCK_SET_GLOBS, ...CONFIG_INTEGRITY_GLOBS, ...x.lockedFiles, ...x.extraProtected],
    }));

    const mounts: Mount[] = [
      { src: job.workdir, dst: "/work" },
      { src: join(jobDir, "in.json"), dst: "/job/in.json", ro: true },
      { src: outDir, dst: "/job/out" },
    ];
    // no git metadata in container A
    if (existsSync(join(job.workdir, ".git"))) {
      mounts.push(lstatSync(join(job.workdir, ".git")).isDirectory()
        ? { src: emptyDir, dst: "/work/.git", ro: true }
        : { src: emptyFile, dst: "/work/.git", ro: true });
    }
    const masks = agentFileMasks(job.workdir);
    for (const f of masks.files) mounts.push({ src: emptyFile, dst: `/work/${f}`, ro: true });
    for (const d of masks.dirs) mounts.push({ src: emptyDir, dst: `/work/${d}`, ro: true });
    if (x.packagesDir) mounts.push({ src: x.packagesDir, dst: "/nuget", ro: true });

    let id: string | undefined;
    try {
      id = await this.rt.create({
        image: AGENT_IMAGE, role: "agent", labels: { run: x.runId, key: x.key }, network: AGENT_NET,
        user: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`, workdir: "/work", mounts,
        env: {
          ...x.agentEnv,
          ANTHROPIC_BASE_URL: API_BASE_URL,
          ANTHROPIC_API_KEY: "added-by-factory-proxy",
          HOME: "/tmp/home", CLAUDE_CONFIG_DIR: "/tmp/claude",
        },
        cmd: [], tmpfs: ["/tmp:exec,size=2g"],
      });
      await x.onContainer?.(id);
      await this.rt.start(id);
      const code = await this.rt.wait(id, job.limits.timeoutSec * 1000);
      await this.rt.stop(id, 5); // kills leftover processes before the core commits
      const resultPath = join(outDir, "result.json");
      const usage = emptyUsage();
      if (code === undefined) return { status: "timeout", usage: { ...usage, wallMs: Date.now() - started } };
      if (!existsSync(resultPath)) return { status: "error", error: `Agent exited ${code} without a result`, usage };
      const out = JSON.parse(readFileSync(resultPath, "utf8")) as AgentOut;
      const u = {
        inputTokens: out.usage.input_tokens ?? 0, outputTokens: out.usage.output_tokens ?? 0,
        cacheRead: out.usage.cache_read_input_tokens ?? 0, cacheWrite: out.usage.cache_creation_input_tokens ?? 0,
        turns: out.turns, wallMs: Date.now() - started, estUsd: out.costUsd,
      };
      // hard check: any instruction file not from the factory fails the step (context-builder §2.9)
      if (out.instructionsLoaded.length) {
        return { status: "error", error: `Agent loaded instruction files: ${out.instructionsLoaded.join(", ")}`, usage: u, sessionId: out.sessionId };
      }
      if (out.status !== "ok") {
        const status = out.status === "over-budget" ? "over-budget" : out.status === "bad-output" ? "bad-output" : out.status === "max-turns" ? "timeout" : "error";
        return { status, error: out.error, usage: u, sessionId: out.sessionId };
      }
      const parsed = job.schema.safeParse(out.output);
      if (!parsed.success) return { status: "bad-output", error: parsed.error.message.slice(0, 500), usage: u, sessionId: out.sessionId };
      return { status: "ok", output: parsed.data, usage: u, sessionId: out.sessionId };
    } finally {
      if (id) {
        await stopAndRemove(this.rt, id).catch(() => undefined);
        await x.onRemoved?.(id);
      }
      rmSync(jobDir, { recursive: true, force: true });
    }
  }
}
