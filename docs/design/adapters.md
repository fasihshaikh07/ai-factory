# Adapter Layer: Simple Design + Explainer (2026-09-26)

Goal: the factory can use any model (Claude, OpenAI, local) for any step, through **one small interface**, with the same safety rules for all. Items marked VERIFY are SDK details to confirm when coding starts.

---

## Part 1. The idea in plain words

**Analogy: a travel plug adapter.** The factory is the laptop, and the AI vendors are countries with different sockets. The laptop doesn't change per country; you swap a small adapter. Here, each "adapter" is a small piece of code (about 100–200 lines) that turns one standard job into whatever that vendor's library expects.

**Two kinds of work, two kinds of adapters:**

| Work | Example steps | What the model needs | Adapter |
|---|---|---|---|
| **Thinking**: read, decide, answer | spec, plan, clarify, critic, review, estimate | Just to read text and answer in a fixed JSON shape | **API runner**: we call the model's API directly |
| **Doing**: change code | write tests, implement | To open files, edit them, run `dotnet test`, see results, try again | **Agent runner**: a ready-made coding engine drives the model |

**Why the split?** A model by itself only produces text. To change code, something has to loop: model decides → tool edits a file → tests run → the model sees the output → repeat. That loop (with safe file editing, context trimming and so on) is hard to build well. Anthropic and OpenAI already ship it as libraries, so we reuse theirs for coding. For thinking steps that loop is unnecessary overhead, so we call the model directly. That's cheaper and works with any vendor.

**One honest detail:** the Claude Agent SDK and the Codex SDK are libraries we call from TypeScript. Underneath, each one starts its vendor's coding engine (the same engine as Claude Code / the Codex CLI) as a background process. We never type commands or scrape terminal output: we get typed events and a JSON result back.

**Model vs engine: two separate choices.**
- **Model** = the brain: Opus 5.5, Sonnet 5, Haiku 4.5, GPT models, local Qwen.
- **Engine** = the hands (coding steps only): Claude Agent SDK, Codex SDK or jcode.

Each engine works with its own vendor's models, plus jcode for local and other models.

---

## Part 2. The design (deliberately small)

### One interface
```ts
interface Runner {
  run(job: Job): Promise<Result>;
}

interface Job {
  step: string;                 // "specify", "implement", ...
  model: string;                // "claude-sonnet-5", "gpt-…", "ollama/qwen3.6"
  prompt: string;               // built by the core
  files: string[];              // context the model may read first
  schema: JSONSchema;           // the exact JSON shape we want back
  workdir?: string;             // agent runners only: the run's worktree
  limits: { maxTurns: number; maxUsd: number; timeoutSec: number };
}

interface Result {
  status: "ok" | "bad-output" | "timeout" | "over-budget" | "error";
  output?: unknown;             // validated JSON
  usage: { inputTokens: number; outputTokens: number; costUsd: number; turns: number };
}
```

### Four runners

| Runner | Library | Models | Used for |
|---|---|---|---|
| **ApiRunner** (ours) | `@anthropic-ai/sdk` (Anthropic API, Bedrock, Vertex) and `openai` (OpenAI API **and** any OpenAI-compatible server: Ollama, vLLM, LM Studio) | Claude, GPT, local | all thinking steps |
| **ClaudeAgentRunner** | `@anthropic-ai/claude-agent-sdk` | Claude | coding steps |
| **CodexRunner** | `@openai/codex-sdk` | OpenAI | coding steps |
| **JcodeRunner** | `@1jehuang/jcode-sdk` | local (Ollama/vLLM) or others | small coding tasks, local commodity steps |

Cursor: optional later (CLI only, no SDK).

**Why only two libraries inside ApiRunner?** Ollama, vLLM and LM Studio all speak the OpenAI API format, so one `openai` client covers OpenAI plus every local server by changing the address. Fewer dependencies, fewer surprises.

### Config: one line per step
```yaml
steps:
  intake:    { runner: api,          model: ollama/qwen3.6 }
  specify:   { runner: api,          model: [claude-opus-5-5, claude-opus-5-5, gpt-…], low-risk: claude-sonnet-5 }
  critic:    { runner: api,          model: gpt-…            }   # other family
  plan:      { runner: api,          model: claude-opus-5-5 }
  implement: { runner: claude-agent, model: claude-sonnet-5, escalate: [claude-opus-5-5] }
  review:    { runner: api,          model: gpt-…            }
credentials:
  anthropic: env:ANTHROPIC_API_KEY
  openai:    env:OPENAI_API_KEY        # or codex-login (Codex runner only)
  ollama:    http://localhost:11434/v1
```
**Two start-up checks** (the factory refuses to run if either fails):
1. Thinking steps may only use `api`; coding steps may only use an agent runner.
2. Every step's model has a working credential. A ChatGPT login alone can't power `api` steps.

### What the core does around every runner (identical for all)

This is where the safety lives, so no adapter can skip it:
1. Build the context pack (only the files this step needs).
2. **Scan it for secrets** (G5). A hit blocks the call.
3. Start a timer and a cost counter; kill the job at the limit.
4. Validate the JSON that comes back; on bad output, re-ask twice with the error, then escalate.
5. Log usage and cost to the ledger.
6. Coding steps only: afterwards, check the diff stayed inside the planned files, and the locked tests are untouched.

So each adapter only translates. It holds no rules of its own.

### Per-runner settings (what each one may touch)

| | ClaudeAgentRunner | CodexRunner | JcodeRunner | ApiRunner |
|---|---|---|---|---|
| Folder | run worktree only (`cwd`) | worktree (`workingDirectory`) | worktree (session workdir) | none (read-only tools we define) |
| Tools | Read, Edit, Write, Glob, Grep, Bash; **no** web tools | built-in, sandbox `workspace-write` | built-in; memory, swarm and self-dev **off** | `read_file`, `search`, `repo_map` only |
| Network | none (sandbox) | none (sandbox default, VERIFY) | none (our sandbox) | only the model API |
| Protected files | hook blocks edits to tests, `.factory/`, CI (PreToolUse, VERIFY) | checked by core after the turn | checked by core after the turn | n/a |
| Lint after each edit | hook (PostToolUse) | core runs lint between turns | core runs lint between turns | n/a |
| Turn / cost cap | native `maxTurns`, `maxBudgetUsd` + core timer | **core timer only** (no native cap found) | core timer | core counts |
| JSON result | `outputFormat: json_schema` | `outputSchema` | `runStructured()` | provider structured output + zod |
| Loads user's own config? | no (`settingSources: []`, VERIFY) | no (VERIFY) | no | n/a |

### How one coding step runs (example: implement TASK-2)
1. The core picks the runner and model from config: `claude-agent`, Sonnet 5.
2. It builds the job: the task recipe from the plan (files to change, one example file, ≤15 rules), the failing test names, the limits.
3. The ClaudeAgentRunner starts the engine in the worktree with only the allowed tools.
4. The engine loops: edit → lint (hook) → run tests. It returns JSON: `{ done, filesChanged, notes }`.
5. The core checks: the diff is inside the planned files, the locked tests are unchanged, the cost is under the cap.
6. Pass → next task. Fail → retry in a **fresh** process with the failure list. Twice → stronger model. Then another vendor, then a human.

### Adding a new vendor later
Write one new runner (~150 lines), add it to the config options, and run the **conformance test**: 5 fixed mini-jobs every runner must pass (return valid JSON, respect the folder, respect the timeout, report usage, refuse a protected-file edit). Nothing else changes.

---

## Part 3. What to say to the judges

**30-second version:**
> The factory never depends on one AI vendor. Every step is a job with a fixed input and a fixed JSON output. Thinking steps call any model's API directly; coding steps use the official coding engines from Anthropic or OpenAI, or jcode for local models. A single config line per step picks the model. All safety checks (secret scanning, cost limits, output validation, locked tests, file scope) live in the factory, outside the models, so swapping a vendor can't weaken them.

**Likely questions:**

| Question | Answer |
|---|---|
| Why not just use Claude Code? | It's one vendor and one session that approves its own work. We use its engine only as the hands for coding, inside our gates, next to other vendors. |
| Why not build your own coding agent? | Safe file editing and context handling are what these engines have perfected. Rebuilding them would be worse and slower. For thinking steps we *do* use our own simple loop, because there it's cheaper. |
| How is it vendor-neutral? | One interface, four small adapters, one config line per step. A new vendor is one adapter plus a conformance test. |
| Can a model cheat, e.g. edit the tests? | The tests are locked by hash before coding. The core checks the diff afterwards, and the evidence ledger is outside the model's reach. |
| Can it run fully offline? | Yes for commodity steps, with Ollama via the same API adapter or jcode. Quality-critical steps are flagged "reduced rigor" when run locally. |
| What does a run cost? | Logged per step. Every run has a hard cap and stops cleanly at it. |
