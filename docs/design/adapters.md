# Adapter Layer: Design and Status (2026-09-26, updated 2026-09-30 to match the code)

Goal: the factory can use any model (Claude, OpenAI, local) for any step, through **one small interface**, with the same safety rules for all.

**Status legend:** *built* = in the code today. *planned* = designed here but not built. *open* = not documented yet; the section lists the questions to answer. Items marked VERIFY are SDK or vendor details to confirm against the code or the vendor. IDs in backticks such as `CACHE-1` refer to the gap register in §29.

**How to read this document.** Sections 1 to 8 describe the layer and how it fits the factory. Sections 9 to 25 cover one concern each: what happens today, known problems, proposed handling and, where stated, what a new runner must provide. Sections 26 to 28 cover testing, adding a vendor and design decisions. Section 29 lists every planned item and open question with a stable ID.

## Contents

Sections 1 to 8 are in this file. Every other section lives in its own file under `adapters/`; read only the one you need. Section numbers are stable, so `§N` anywhere in the docs means the row below.

| § | Section | File |
|---|---|---|
| 1 | Glossary | this file |
| 2 | Overview | this file |
| 3 | Interface and layering (built, `src/runners/types.ts`) | this file |
| 4 | Runners | this file |
| 5 | Routing config (built, `src/config/project.ts`, defaults in `src/stages/routing.ts`) | this file |
| 6 | Per-runner settings (what each one may touch) | this file |
| 7 | What the core does around every runner (identical for all) | this file |
| 8 | How one coding step runs (example: implement TASK-2) | this file |
| 9 | Message and content model | [adapters/messages-and-tools.md](adapters/messages-and-tools.md) |
| 10 | Structured output | [adapters/messages-and-tools.md](adapters/messages-and-tools.md) |
| 11 | Tool calling | [adapters/messages-and-tools.md](adapters/messages-and-tools.md) |
| 12 | Stop reasons and errors | [adapters/errors-and-retries.md](adapters/errors-and-retries.md) |
| 13 | Streaming *(open)* | [adapters/open-topics.md](adapters/open-topics.md) |
| 14 | Context window management *(open)* | [adapters/open-topics.md](adapters/open-topics.md) |
| 15 | Usage and cost | [adapters/usage-and-caching.md](adapters/usage-and-caching.md) |
| 16 | Prompt caching | [adapters/usage-and-caching.md](adapters/usage-and-caching.md) |
| 17 | Retries | [adapters/errors-and-retries.md](adapters/errors-and-retries.md) |
| 18 | Timeouts and cancellation | [adapters/errors-and-retries.md](adapters/errors-and-retries.md) |
| 19 | Concurrency and rate limits *(open)* | [adapters/open-topics.md](adapters/open-topics.md) |
| 20 | Parameter mapping | [adapters/usage-and-caching.md](adapters/usage-and-caching.md) |
| 21 | Capability registry *(planned)* | [adapters/registry-and-vendors.md](adapters/registry-and-vendors.md) |
| 22 | Determinism and replay | [adapters/determinism-and-testing.md](adapters/determinism-and-testing.md) |
| 23 | Observability and tracing | [adapters/security-observability.md](adapters/security-observability.md) |
| 24 | Security and data handling | [adapters/security-observability.md](adapters/security-observability.md) |
| 25 | Agent wire contract *(open)* | [adapters/open-topics.md](adapters/open-topics.md) |
| 26 | Testing | [adapters/determinism-and-testing.md](adapters/determinism-and-testing.md) |
| 27 | Adding a new vendor | [adapters/registry-and-vendors.md](adapters/registry-and-vendors.md) |
| 28 | Decisions and alternatives | [adapters/decisions-and-gaps.md](adapters/decisions-and-gaps.md) |
| 29 | Gap register | [adapters/decisions-and-gaps.md](adapters/decisions-and-gaps.md) |

### Which file to read

| File | Read it when you need |
|---|---|
| [adapters/messages-and-tools.md](adapters/messages-and-tools.md) (§9, §10, §11) | prompt/turn model, provider normalization, JSON schema output, tool gating |
| [adapters/errors-and-retries.md](adapters/errors-and-retries.md) (§12, §17, §18) | error classes, stop-reason mapping, ladder and retry levels, timeouts, cancellation |
| [adapters/usage-and-caching.md](adapters/usage-and-caching.md) (§15, §16, §20) | token/cost accounting and caps, prompt caching, Job-to-vendor parameter translation |
| [adapters/determinism-and-testing.md](adapters/determinism-and-testing.md) (§22, §26) | what is reproducible, resume/replay, six-layer test strategy and gaps |
| [adapters/registry-and-vendors.md](adapters/registry-and-vendors.md) (§21, §27) | per-model capability data, checklist for a new vendor |
| [adapters/security-observability.md](adapters/security-observability.md) (§23, §24) | trace events, data handling, egress and secrets |
| [adapters/open-topics.md](adapters/open-topics.md) (§13, §14, §19, §25) | streaming, context window, concurrency/rate limits, agent wire contract (all still open) |
| [adapters/decisions-and-gaps.md](adapters/decisions-and-gaps.md) (§28, §29) | design decisions and alternatives, every planned/open item with a stable ID |

---

## 1. Glossary

| Term | Meaning in this document |
|---|---|
| Core | The factory code outside the runners: stages, gates, ledger, context builder and test lab. It owns every decision. |
| Step | One pipeline stage, such as `intake`, `specify` or `implement`. |
| Job | What the core hands a runner for one step: model, effort, context pack, schema and limits (§3). |
| Context pack | The prompt material the core builds for a step (§9). |
| Runner | Executes one job and returns a `Result`. Two families: the API runner for thinking steps and agent runners for coding steps (§4). |
| Provider | Inside `ApiRunner`, the class that translates the normalized turn model into one vendor's API: `AnthropicProvider` or `OpenAIProvider` (§9). |
| Engine | The vendor coding engine an agent runner drives: the Claude Agent SDK today; the Codex SDK and jcode are planned. |
| Adapter | Used loosely for any vendor-specific translation code, a provider or an agent runner's engine wrapper. Where the difference matters, this document says runner, provider or engine. |
| Model | The model id a step is routed to. A separate choice from the engine. |
| Ladder, rung | The core's escalation sequence after a failed step (§17). |

---

## 2. Overview

**Analogy: a travel plug adapter.** The factory is the laptop, and the AI vendors are countries with different sockets. The laptop doesn't change per country; you swap a small adapter. Here, each "adapter" is a small piece of code (about 100–200 lines) that turns one standard job into whatever that vendor's library expects.

**Two kinds of work, two kinds of adapters:**

| Work | Example steps | What the model needs | Adapter |
|---|---|---|---|
| **Thinking**: read, decide, answer | spec, plan, clarify, critic, review, estimate | Just to read text and answer in a fixed JSON shape | **API runner**: we call the model's API directly |
| **Doing**: change code | write tests, implement | To open files, edit them, run `dotnet test`, see results, try again | **Agent runner**: a ready-made coding engine drives the model |

**Why the split?** A model by itself only produces text. To change code, something has to loop: model decides → tool edits a file → tests run → the model sees the output → repeat. That loop (with safe file editing, context trimming and so on) is hard to build well. Anthropic and OpenAI already ship it as libraries, so we reuse theirs for coding. For thinking steps that loop is unnecessary overhead, so we call the model directly. That's cheaper and works with any vendor.

**One honest detail:** the Claude Agent SDK (built) and the Codex SDK (planned) are libraries we call from TypeScript. Underneath, each one starts its vendor's coding engine (the same engine as Claude Code / the Codex CLI) as a background process. We never type commands or scrape terminal output: we get typed events and a JSON result back.

**Model vs engine: two separate choices.**
- **Model** = the brain: Opus 5.5, Sonnet 5, Haiku 4.5, GPT models, local Qwen.
- **Engine** = the hands (coding steps only): Claude Agent SDK (built), Codex SDK or jcode (both planned).

Each engine works with its own vendor's models, plus jcode for local and other models.

---

## 3. Interface and layering (built, `src/runners/types.ts`)

```ts
interface Runner {
  readonly kind: "api" | "claude-agent" | "codex" | "jcode";
  run<T>(job: Job<T>): Promise<Result<T>>;
}

interface Job<T> {
  step: StageName;              // "specify", "implement", ...
  model: string;                // "claude-sonnet-5", "gpt-…", "ollama/qwen3.6"
  effort?: "low" | "medium" | "high" | "xhigh";
  pack: ContextPack;            // built by the core: system, user, pointers, allowed tools
  schema: z.ZodType<T>;         // the exact shape we want back (zod is the single schema source)
  workdir?: string;             // agent runners only: the run's worktree
  limits: { maxTurns: number; maxUsd: number; timeoutSec: number };
}

interface Result<T> {
  status: "ok" | "bad-output" | "timeout" | "over-budget"
        | "rate-limited" | "refused" | "config-error" | "error";
  output?: T;                   // validated against the schema
  error?: string;
  usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number;
           turns: number; wallMs: number; estUsd: number };
  sessionId?: string;           // vendor session id, audit only
}
```

`config-error` means the API said no in a way retrying cannot fix (bad key, unknown model, bad request). Errors are still coarse status labels today; a fixed error taxonomy owned by the adapters is *planned* (`ERR-1`, see §12).

### Layers

Three layers take part in every model call.

| Layer | Owns | Code |
|---|---|---|
| Core | Decisions: routing, the ladder, backoff, run caps, diff gates, the ledger | `src/stages`, `src/gates`, `src/ledger` |
| Runner | Executing one job: the tool loop, re-asks, step caps (today), mapping the outcome to `Result` | `src/runners/api.ts`, `src/runners/claude-agent.ts` |
| Provider or engine | Translating to one vendor | `AnthropicProvider`, `OpenAIProvider`; the Claude Agent SDK driven by `docker/agent/run-agent.mjs` |

`ApiRunner` reaches vendors only through providers and the turn model in §9, although some model-specific checks such as `supportsEffort` also live in `api.ts` (§20). Today `ApiRunner` also enforces turn, cost and deadline limits and the re-ask count, which the design intends for the core (§7, `CORE-1`).

---

## 4. Runners

| Runner | Status | Library | Models | Used for |
|---|---|---|---|---|
| **ApiRunner** (ours) | built | `@anthropic-ai/sdk` (Anthropic API only; Bedrock and Vertex are *planned*) and `openai` (OpenAI API **and** any OpenAI-compatible server: Ollama, vLLM, LM Studio) | Claude, GPT, local | all thinking steps |
| **ClaudeAgentRunner** | built | `@anthropic-ai/claude-agent-sdk`, run inside a sealed container | Claude | coding steps |
| **CodexRunner** | planned | `@openai/codex-sdk` | OpenAI | coding steps; enables the "other vendor" ladder rung |
| **JcodeRunner** | planned | `@1jehuang/jcode-sdk` | local (Ollama/vLLM) or others | small coding tasks, local commodity steps |

The config schema already accepts `codex` and `jcode`, but the start-up check rejects them as "not built yet".

Cursor: optional later (CLI only, no SDK).

**Why only two libraries inside ApiRunner?** Ollama, vLLM and LM Studio all speak the OpenAI API format, so one `openai` client covers OpenAI plus every local server by changing the address. Fewer dependencies, fewer surprises.

---

## 5. Routing config (built, `src/config/project.ts`, defaults in `src/stages/routing.ts`)

Optional `steps:` block in the project file `~/.factory/projects/<name>.yaml`. Each step takes a single model string. Anything left out uses the built-in default for that step.
```yaml
steps:
  intake:    { runner: api,          model: claude-haiku-4-5, escalate: [claude-sonnet-5], effort: low }
  critic:    { runner: api,          model: gpt-5.5,          effort: high }   # other family
  plan:      { runner: api,          model: claude-opus-5-5,  effort: high }
  implement: { runner: claude-agent, model: claude-sonnet-5,  escalate: [claude-opus-5-5], effort: high }
  review:    { runner: api,          model: gpt-5.5,          effort: high }
```
- Steps with several parallel drafts (the spec drafts) use a second step, `specify-other`, for the other-family model. A list of models per step and a `low-risk:` override are *not* supported.
- The project file never holds secrets. Credentials are read from `~/.factory/.env`: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OLLAMA_BASE_URL` (default `http://localhost:11434/v1`). There is no `credentials:` block.
- If a step is routed to a `gpt-*` model and `OPENAI_API_KEY` is missing, the factory runs it on Opus instead and records a "same family as the implementer" note (`modelFor`).
- Rung escalation: raise effort, then the first `escalate` model. The "other vendor" rung is *planned* and only exists once the Codex runner is built.

**Start-up checks** (`checkRoutes`; the factory refuses to run if a check fails):
1. Thinking steps may only use `api`; coding steps may only use an agent runner. *Built.*
2. A `codex` or `jcode` route is rejected until those runners exist. *Built.*
3. Claude models need `ANTHROPIC_API_KEY`. *Built.* An equivalent check for OpenAI and Ollama models is *planned*: today a missing OpenAI key silently falls back to Opus (see above).

---

## 6. Per-runner settings (what each one may touch)

The ClaudeAgentRunner and ApiRunner columns are *built*. The CodexRunner and JcodeRunner columns are *planned*.

| | ClaudeAgentRunner (built) | CodexRunner (planned) | JcodeRunner (planned) | ApiRunner (built) |
|---|---|---|---|---|
| Folder | run worktree only, mounted at `/work` in a sealed container; git metadata, agent instruction files, tracked secret files and no-go folders are masked read-only | worktree (`workingDirectory`) | worktree (session workdir) | none (read-only tools we define) |
| Tools | `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`; `permissionMode: dontAsk`; no web tools | built-in, sandbox `workspace-write` | built-in; memory, swarm and self-dev **off** | `read_file`, `search`, `repo_map` only |
| Network | none: an internal container network; model calls go through a key proxy, and the agent never holds the real API key | none (sandbox default, VERIFY) | none (our sandbox) | only the model API |
| Protected files | `PreToolUse` hook denies edits to protected paths and blocks git, network and package installs; then checked again by the core diff gates | checked by core after the turn | checked by core after the turn | n/a |
| Lint after each edit | **not implemented** (`PostToolUse` lint hook is still to do) | core runs lint between turns | core runs lint between turns | n/a |
| Turn / cost cap | native `maxTurns`, `maxBudgetUsd` inside the container, plus a wall-clock wait in the runner | **core timer only** (no native cap found) | core timer | counted inside `ApiRunner` |
| JSON result | `outputFormat: json_schema`, then validated with zod | `outputSchema` | `runStructured()` | `submit_result` tool call, validated with zod |
| Loads user's own config? | no (`settingSources: []`); the step fails if any instruction file was loaded | no (VERIFY) | no | n/a |

---

## 7. What the core does around every runner (identical for all)

This is where the safety lives, so no adapter can skip it. Where the code differs from the intended design, it is noted:
1. Build the context pack (only the files this step needs). *Built* (`src/context/pack.ts`). Untrusted sections may not go in the system prompt or into a step that can write.
2. **Redact secrets** from the pack and from tool results. *Built* (`src/context/secrets.ts`): matches become stable placeholders such as `«SECRET_1»`, values are never stored, and the pack manifest records a `redactions` count. It redacts rather than blocks the call. Blocking on a hit is *not* implemented.
3. Start a timer and a cost counter; stop the job at the limit. *Built, but inside the runners:* `ApiRunner` counts turns, cost and the deadline itself. The Claude agent gets `maxTurns` and `maxBudgetUsd` inside its container, plus a wall-clock wait in the runner. Moving this into the core is *planned* for the runners that have no native cap (Codex).
4. Validate the JSON that comes back; on bad output, re-ask twice with the error, then escalate. *Built inside `ApiRunner`* (`MAX_REASKS = 2`). The agent's output is validated once against the zod schema.
5. Log usage and cost to the ledger. *Built* (`onUsage`); the agent runner reports usage once, at the end.
6. Coding steps only: afterwards, check the diff stayed inside the planned files, the locked tests are untouched, and no protected file or secret changed. *Built* (`src/stages/build.ts` runs the diff gates before any test run).

The intent is that each adapter only translates. Today the loop in items 3 and 4 lives in `ApiRunner`; not in the core (`CORE-1`).

---

## 8. How one coding step runs (example: implement TASK-2)

1. The core picks the runner and model from config: `claude-agent`, Sonnet 5.
2. It builds the job: the task recipe from the plan (files to change, one example file, ≤15 rules), the failing test names, the limits.
3. The ClaudeAgentRunner starts the engine in the worktree with only the allowed tools.
4. The engine loops: edit → run tests (a lint hook after each edit is planned, `AGENT-1`). It returns JSON: `{ done, filesChanged, notes }`.
5. The core checks: the diff is inside the planned files, the locked tests are unchanged, the cost is under the cap.
6. Pass → next task. Fail → retry in a **fresh** process with the failure list. Twice → stronger model. Then another vendor (planned, `RUN-1`), then a human.
