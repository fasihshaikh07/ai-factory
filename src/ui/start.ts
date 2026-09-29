// Starting a run from `factory ui`: exactly what `factory start` does (loadProject, checkRoutes,
// gatherRequest, createRun), then the executor runs in the background like the MCP start.
// An uploaded file is written to a private temp folder under its own name and read by
// gatherRequest like `--file`; a Jira key goes through gatherRequest like `--jira`.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { basename, join } from "node:path";
import { loadProject } from "../config/project.js";
import { costCapUsd, MIN_CAP_USD } from "../ledger/caps.js";
import { describeSources, gatherRequest } from "../sources/request.js";
import { runDetached } from "../stages/background.js";
import { createRun } from "../stages/executor.js";
import { checkRoutes } from "../stages/routing.js";
import { factoryHome } from "../util/paths.js";
import { busyRun, projectNames } from "./data.js";

export class StartError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export interface StartInput {
  project?: unknown;
  prompt?: unknown;
  file?: unknown; // { name, text }
  jira?: unknown;
  maxCost?: unknown;
}

export interface StartDeps {
  /** runs the executor in the background (tests pass a stub) */
  execute?: (runId: string) => void;
  gather?: typeof gatherRequest;
}

/** The highest normal cost limit (a large change). --max-cost can only lower the limit, so more than this is refused. */
export const HIGHEST_NORMAL_CAP_USD = Math.max(MIN_CAP_USD, ...(["S", "M", "L"] as const).map((c) => costCapUsd(undefined, c)));

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);

// a project that just started a run counts as busy until its executor holds the lock
const starting = new Map<string, { runId: string; at: number }>();

export async function startRun(input: StartInput, deps: StartDeps = {}): Promise<{ runId: string; from: string }> {
  const project = str(input.project);
  if (!project) throw new StartError("Pick a project.");
  if (!projectNames().includes(project)) throw new StartError(`No project "${project}". Add one with: factory init <repo>`);

  let maxCostUsd: number | undefined;
  if (input.maxCost !== undefined && input.maxCost !== null && input.maxCost !== "") {
    maxCostUsd = Number(input.maxCost);
    if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) throw new StartError("Max cost must be a positive number of dollars.");
    if (maxCostUsd > HIGHEST_NORMAL_CAP_USD) {
      throw new StartError(`Max cost can only lower the normal limit, and the highest normal limit is $${HIGHEST_NORMAL_CAP_USD}. Enter $${HIGHEST_NORMAL_CAP_USD} or less, or leave it empty.`);
    }
  }

  let file: { name: string; text: string } | undefined;
  if (input.file !== undefined && input.file !== null) {
    const f = input.file as { name?: unknown; text?: unknown };
    if (typeof f.name !== "string" || typeof f.text !== "string") throw new StartError("The uploaded file couldn't be read.");
    const name = basename(f.name.replace(/\\/g, "/"));
    if (!/^[\w .()-]{1,100}\.(md|markdown|txt)$/i.test(name)) throw new StartError("Upload a Markdown (.md) or text (.txt) file.");
    file = { name, text: f.text };
  }

  // the same checks, in the same order, as `factory start`
  const cfg = loadProject(project);
  const problems = checkRoutes(cfg);
  if (problems.length) throw new StartError(`Setup problems:\n- ${problems.join("\n- ")}`);

  const busy = (await busyRun(project)) ?? (() => {
    const s = starting.get(project);
    return s && Date.now() - s.at < 30_000 ? { runId: s.runId } : undefined;
  })();
  if (busy) throw new StartError(`Run ${busy.runId} is already running on ${project}. Wait for it to stop at a card, park or finish.`, 409);

  // everything is read before a run exists: a bad file or ticket costs nothing
  let dir: string | undefined;
  let req;
  try {
    let path: string | undefined;
    if (file) {
      mkdirSync(join(factoryHome(), "tmp"), { recursive: true, mode: 0o700 });
      dir = mkdtempSync(join(factoryHome(), "tmp", "ui-upload-"));
      path = join(dir, file.name);
      writeFileSync(path, file.text, { mode: 0o600 });
    }
    req = await (deps.gather ?? gatherRequest)({ prompt: str(input.prompt), file: path, jira: str(input.jira)?.trim() });
  } catch (e) {
    throw new StartError((e as Error).message);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  const runId = await createRun(req.text, project, `${userInfo().username} (via web)`, {
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    sources: req.sources,
  });
  starting.set(project, { runId, at: Date.now() });
  (deps.execute ?? runDetached)(runId);
  return { runId, from: describeSources(req.sources) };
}

export function _resetStarting(): void {
  starting.clear();
}
