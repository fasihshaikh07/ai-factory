// Project config: ~/.factory/projects/<name>.yaml (contracts §3, trimmed to the POC).
// Never holds secrets: credentials are env var names resolved from ~/.factory/.env.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { factoryHome } from "../util/paths.js";

const StepRoute = z.object({
  runner: z.enum(["api", "claude-agent", "codex", "jcode"]),
  model: z.string(),
  escalate: z.array(z.string()).default([]),
  effort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
});
export type StepRoute = z.infer<typeof StepRoute>;

export const ProjectConfig = z.object({
  project: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  repo: z.string(),
  baseBranch: z.string().default("main"),
  stack: z.literal("dotnet"),
  forge: z.object({ kind: z.enum(["github", "bitbucket"]), repo: z.string(), tokenEnv: z.string().default("GITHUB_TOKEN") }).optional(),
  dotnet: z.object({
    sdkImage: z.string().default("mcr.microsoft.com/dotnet/sdk:8.0"),
    solution: z.string().optional(),
    buildTimeoutSec: z.number().default(900),
    testTimeoutSec: z.number().default(1800),
    /** Runner settings passed after `--` on the command line (never by editing repo config). */
    runnerArgs: z.array(z.string()).default([]),
  }).default({ sdkImage: "mcr.microsoft.com/dotnet/sdk:8.0", buildTimeoutSec: 900, testTimeoutSec: 1800, runnerArgs: [] }),
  database: z.object({
    image: z.string().default("postgres:16-alpine"),
    name: z.string().default("app_test"),
    /** Login the repo's tests use. Created with CREATEDB, never superuser. */
    user: z.string().default("factory"),
    /** Env var in ~/.factory/.env holding that login's test password (when the tests hardcode one). */
    passwordEnv: z.string().optional(),
    /** Producer env template: only container B gets these. {{DB_*}} are filled by the core. */
    producerEnv: z.record(z.string(), z.string()).default({}),
    migrate: z.array(z.string()).optional(),
  }).optional(),
  /** Agent env template: dummy values so the app compiles in container A. */
  agentEnv: z.record(z.string(), z.string()).default({}),
  /** Read-only reference DB for discover (D9): the env var holding its connection string. */
  referenceDb: z.object({ connEnv: z.string() }).optional(),
  noGo: z.array(z.string()).default([]),
  policy: z.record(z.string(), z.unknown()).default({}),
  steps: z.record(z.string(), StepRoute).default({}),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

export function projectPath(name: string): string {
  return join(factoryHome(), "projects", `${name}.yaml`);
}

export function loadProject(name: string): ProjectConfig {
  const p = projectPath(name);
  if (!existsSync(p)) throw new Error(`No project "${name}". Create ${p} (see docs/project-example.yaml).`);
  return ProjectConfig.parse(parse(readFileSync(p, "utf8")));
}

/** Fill {{DB_HOST}} etc. in an env template. */
export function fillTemplate(env: Record<string, string>, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) out[k] = v.replace(/\{\{(\w+)\}\}/g, (_, n: string) => vars[n] ?? "");
  return out;
}
