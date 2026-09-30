# Adapter Layer (2026-09-26, updated 2026-09-30 to match the code)

## Summary

**What it does.** The factory can use any model (Claude, OpenAI, local) for any step through one small interface, with the same safety rules for all. Each adapter only translates between that interface and one vendor. The core owns every decision: routing, retries, caps, gates and the ledger.

**Two kinds of runner.**
- Thinking steps (intake, ground, clarify, spec, critic, plan, review) use the **API runner**, our own small loop that calls the model API directly and gets JSON back.
- Coding steps (write tests, implement) use an **agent runner**: a vendor's coding engine drives the model inside a sealed container.

**What's built.**
- The API runner, with Anthropic, OpenAI and local OpenAI-compatible servers (Ollama, vLLM, LM Studio).
- The Claude agent runner, in a container with no network and a key proxy.
- Routing per step, with a light lane for small, low-risk changes.
- Step budgets that never exceed what is left of the run's cost limit.
- Usage and cost written to the ledger after every model call.
- Diff gates after every coding step.

**What's still open.**
- The Codex and jcode runners. Until Codex exists there is no "other vendor" step on the retry ladder.
- One shared set of error classes for all runners, and one conformance suite every runner must pass. A separate proposal covers both.
- Stopping a step that is already running (today pause and stop wait for the step to end).
- A few gaps listed at the end, under "Known gaps".

---

## Why two kinds of runner

A model by itself only produces text. To change code, something has to loop: the model decides, a tool edits a file, tests run, the model sees the result, and so on. That loop, with safe file editing and context trimming, is hard to build well, and Anthropic and OpenAI already ship it as libraries. So coding steps reuse a vendor engine. Thinking steps don't need that loop, so calling the model directly is cheaper and works with any vendor.

The model and the engine are separate choices. The model is the brain (Opus 5.5, Sonnet 5, Haiku 4.5, GPT, local Qwen). The engine is the hands, for coding steps only (the Claude Agent SDK today).

The agent SDK is a library we call from TypeScript. Underneath, it starts the vendor's coding engine as a background process. We get typed events and a JSON result back; we never type commands into a terminal or scrape its output.

## The interface (`src/runners/types.ts`)

```ts
interface Runner {
  readonly kind: "api" | "claude-agent" | "codex" | "jcode";
  run<T>(job: Job<T>): Promise<Result<T>>;
}

interface Job<T> {
  step: StageName;              // "specify", "implement", ...
  model: string;                // "claude-sonnet-5", "gpt-5.5", "ollama/qwen3.6"
  effort?: "low" | "medium" | "high" | "xhigh";
  pack: ContextPack;            // built by the core: system text, user text, file pointers, allowed tools
  schema: z.ZodType<T>;         // the exact shape we want back
  workdir?: string;             // agent runners only: the run's worktree
  limits: { maxTurns: number; maxUsd: number; timeoutSec: number };
}

interface Result<T> {
  status: "ok" | "bad-output" | "timeout" | "over-budget"
        | "rate-limited" | "refused" | "config-error" | "error";
  output?: T;                   // validated against the schema
  error?: string;
  usage: { inputTokens; outputTokens; cacheRead; cacheWrite; turns; wallMs; estUsd };
  sessionId?: string;           // vendor session id, for audit only
}
```

`config-error` means the API said no in a way a retry can't fix: a bad key, an unknown model or a bad request.

## Runners

| Runner | Status | Library | Used for |
|---|---|---|---|
| API runner | built | `@anthropic-ai/sdk` and `openai`. The `openai` client also covers Ollama, vLLM and LM Studio, which speak the same format. | all thinking steps |
| Claude agent runner | built | `@anthropic-ai/claude-agent-sdk`, inside a sealed container | coding steps |
| Codex runner | not built | `@openai/codex-sdk` | coding steps on OpenAI models |
| jcode runner | not built | `@1jehuang/jcode-sdk` | small coding tasks on local models |

The project file accepts `codex` and `jcode`, but the start-up check refuses them until they exist. Bedrock and Vertex are not supported yet.

## What the core does around every runner

This is where the safety lives, so no adapter can skip it.

1. **Builds the context pack** with only what the step needs. Untrusted text never goes in the system prompt or into a step that can write.
2. **Redacts secrets** from the pack and from tool results. A match becomes a placeholder such as `«SECRET_1»`, and the pack records how many were replaced. The call still goes ahead; nothing blocks on a match.
3. **Sets the limits.** A step's spend limit is never more than what's left of the run's cost limit (with a $0.25 floor), so one step can't overshoot the run. The runners enforce the turn, cost and time limits themselves today.
4. **Checks the answer** against the step's schema. The API runner re-asks up to twice with the errors. The agent's answer is checked once.
5. **Records usage and cost** in the run ledger after every model call. The agent runner reports once, at the end.
6. **Runs the diff gates** after a coding step: the diff stays inside the planned files, the locked tests are untouched, and no protected file or secret changed.

## Routing

Each step has a default model (`src/stages/routing.ts`). A project can override any step in `~/.factory/projects/<name>.yaml`:

```yaml
steps:
  intake:    { runner: api,          model: claude-haiku-4-5, escalate: [claude-sonnet-5], effort: low }
  critic:    { runner: api,          model: gpt-5.5,          effort: high }   # other family
  plan:      { runner: api,          model: claude-opus-5-5,  effort: high }
  implement: { runner: claude-agent, model: claude-sonnet-5,  escalate: [claude-opus-5-5], effort: high }
```

- Each step takes one model. The spec drafts use a second step, `specify-other`, for the other-family draft.
- Keys live in `~/.factory/.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`), never in the project file.
- If a step is routed to a GPT model and there is no OpenAI key, it runs on Opus instead, and the step records a "same family as the implementer" note.
- **Light lane.** For a small, low-risk change the factory uses a cheaper pipeline: one spec draft, one repair round, a critic at medium effort, 8 grounding turns instead of 12, and Sonnet instead of Opus as the test writer with 25 turns instead of 60. A project that routes the test writer itself keeps its choice, and escalation still moves to the stronger model.

**Start-up checks.** The factory refuses to start if a thinking step doesn't use the API runner, a coding step doesn't use an agent runner, a step uses `codex` or `jcode`, or a Claude model has no Anthropic key. There is no matching check for OpenAI or Ollama yet: a missing OpenAI key falls back to Opus, as above.

## What each runner may touch

| | Claude agent runner | API runner |
|---|---|---|
| Files | The run's worktree only, mounted at `/work`. Git metadata, agent instruction files, tracked secret files and no-go folders are masked read-only. | None. It gets three read-only tools the core serves over a snapshot of the repo. |
| Tools | `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`. No web tools. Nothing prompts for permission. | `read_file` (400 lines a call), `search` (50 hits), `repo_map`, and `submit_result` for the answer. |
| Network | None. Model calls go through a key proxy, so the agent never holds the real key. | Only the model API. |
| Guard on edits | A hook refuses edits outside the worktree, to protected paths or outside the task's files. It also refuses Bash commands that use git, curl, wget, nc, ssh, `dotnet add`, `dotnet nuget` or `npm install`. The core diff gates check again afterwards. | Paths outside the repo, secret paths and no-go paths are refused. |
| Limits | The SDK's own turn and budget limits inside the container, plus a wall-clock wait in the runner. | Counted by the runner, turn by turn. |
| Answer | The SDK's JSON-schema output, then checked with zod. | The `submit_result` tool call, checked with zod. |
| User's own config | Not loaded. The step fails if any instruction file was loaded. | Not applicable. |

The Bash check is a text match, so it is a convenience. The real boundaries are the container and the diff gates. A lint check after each edit is not built.

## How a thinking step runs

1. The core picks the model and effort for the step and ladder position, and builds the pack.
2. The API runner offers the step's read tools plus `submit_result`, whose input is the step's schema.
3. Each turn, the runner answers every tool call. A valid `submit_result` ends the step. An invalid one gets the schema errors back and counts as a re-ask. A plain-text answer gets "call submit_result" and also counts as a re-ask.
4. After two re-asks the step ends with `bad-output`.
5. One turn before the last, the runner tells the model its next turn is its last and it should submit what it has.
6. If the turn limit runs out anyway, the step ends with `bad-output` ("No result after N turns").

### How each provider is called

| | Anthropic | OpenAI | Local servers (Ollama, vLLM, LM Studio) |
|---|---|---|---|
| API | Messages, streamed and read as one final message | Responses API | Chat completions |
| System prompt | `system`, marked for caching | `instructions` | a `developer` message |
| Effort | `output_config.effort`, only for models that accept it (not Haiku 4.5); defaults to high | `reasoning: { effort }` when set; `xhigh` passed through unchanged | not sent |
| History between turns | Full content, including thinking blocks, sent back unchanged | Nothing stored at OpenAI (`store: false`); the output items, including encrypted reasoning, are sent back each turn | the assistant message |
| Output cap | 32,000 tokens | none set | none set |
| Client retries | 2 | 0 | 0 |

Bad JSON in an OpenAI or local tool call becomes `{ __unparsable: true }`, which fails the schema and triggers a re-ask.

## How a coding step runs (example: implement TASK-2)

1. The core picks the runner and model: `claude-agent`, Sonnet 5.
2. It builds the job: the task recipe from the plan (files to change, one example file, up to 15 rules), the failing test names and the limits.
3. The agent runner starts the engine in the container with only the allowed tools.
4. The engine edits and runs tests, then returns `{ done, filesChanged, notes }`.
5. The core checks the diff, the locked tests and the cost.
6. Pass: next task. Fail: the ladder below.

The conversation stays inside the engine. The core sees only the final result and a progress file with each tool call and a short line per turn. Every retry starts a fresh container with the failure list in the task text.

## When a step fails

### How vendor signals become a status

| Signal | Status |
|---|---|
| Anthropic `stop_reason: refusal`; OpenAI refusal content; local `message.refusal` | `refused` |
| Output cap hit (Anthropic `max_tokens`, OpenAI `incomplete_details.reason: "max_output_tokens"`, local `finish_reason: length`) | No status of its own. The trace line says "hit max tokens", and a turn without a tool call is re-asked like a plain-text answer. |
| HTTP 429 or 5xx, or Anthropic 529 (after Anthropic's 2 client retries; OpenAI has none) | `rate-limited` |
| HTTP 400, 401, 403, 404 | `config-error` |
| Any other error, including network failures | `error` |
| API runner's turn limit | `bad-output` |
| Agent: turn limit | `timeout` |
| Agent: budget limit | `over-budget` |
| Agent: structured-output retries used up | `bad-output` |
| Agent: API error 400 to 404 | `config-error` |
| Agent: API error 429 or 5xx, a crash, a missing result, or a loaded instruction file | `error` |
| Agent: the container wait times out | `timeout` |

The agent path never returns `rate-limited` or `refused`. The two runners also disagree on the turn limit. The error-class proposal fixes both.

### What the core does with it

- `config-error`: the run parks right away. Paying for retries would not help.
- `rate-limited`: the core waits and tries again without counting an attempt. The wait starts at 30 seconds and doubles. After 15 minutes of waiting, the run parks.
- Anything else climbs the ladder: two attempts per step of the ladder, moving up early when the same failure repeats. The steps are retry with the failure list, raise effort to `xhigh`, then the step's first `escalate` model. A step has six counted attempts in total. When the ladder is used up, the run parks for a human.

### Switching vendors

The user picks the vendors a run may use, so the ladder never switches vendor on its own:
- A move to another vendor may only pick a model the run already allows: one named in the project's routes and permitted by the policy's `allowedModels`.
- If no such model exists, the ladder skips that step and the run parks with a card, so the user decides.
- A refusal never triggers a vendor switch by itself. After one retry, the user decides.

This step doesn't exist yet (it needs the Codex runner). The policy's `allowedModels` list is defined but nothing checks it today; the vendor step must check it when it is built.

### Hidden retries

The Anthropic client retries twice before the runner sees an error. Those retries are not logged or counted, so an outage costs more time than the trace shows. The OpenAI client doesn't retry. The agent engine's own retries are not visible either.

## Cost

- **Prices** come from `src/runners/pricing.ts` (USD per million tokens for input, output, cache read and cache write). A project can add prices with a `prices:` block; GPT models need one.
- **Unknown models** are priced like the most expensive known one ($10 in, $50 out per million tokens), so caps stay safe but fill early. Nothing in the trace or report says a fallback price was used. `ollama/*` models cost nothing.
- **The agent's cost** comes from the SDK's own total, not our price table. On a container timeout or a missing result file, the agent's spend is lost: the runner returns empty usage.
- **Limits.** Each step has a spend limit ($2 for a thinking call, $4 for writing tests or implementing), cut down to what's left of the run's limit. The API runner applies it to each call it makes, so a step that makes several calls (the spec loop) has no limit on its total. The run's limit depends on the size of the change, is never below $10 before a human waiver, and `--max-cost` can only lower it. It is checked between steps.
- Costs are estimates; nothing is reconciled with a vendor bill.

## Caching

- **Anthropic:** the system prompt and the growing conversation are marked for caching, so each tool turn re-reads earlier turns at the cheaper cached price. A retry of the same step within a few minutes can reuse the cache too.
- **OpenAI:** it caches matching prefixes by itself. We read the cached count from usage; cache writes are always 0.
- **Parallel and one-shot calls.** Parallel calls (the three clarify readings, the spec drafts) start together, so each pays to write the cache and none reads it. One-shot calls write a cache nobody reads. Writing costs 1.25 times normal input.
- **The run report** shows uncached input and cache reads in separate columns, but not cache writes or a hit rate.

## Timeouts and stopping

- **API runner:** the step's time limit is checked between turns. A call that hangs is never interrupted. The code sets no client timeout, so the SDK defaults apply.
- **Agent runner:** the runner waits for the container up to the time limit, then removes it and returns `timeout`.
- **Default limits:** 900 seconds for a thinking call, and 45 minutes for writing tests and for implementing.
- **Active time.** The whole run has an active-time limit (twice the expected time for its size), checked between steps.
- **Pause and stop.** `factory pause` and `factory stop` are read between steps, so a running step finishes first. There is no way to cancel a call or a container mid-step, and Ctrl-C does not clean up. At the next start the executor removes the run's containers and records the interruption; three interruptions park the run.

## What gets recorded

- **Ledger:** a `usage` event per model call (model, input, output, cache read, cache write, cost); gate results with their inputs and policy hash; every pack, stored by its hash, with a manifest (stage, model, sections, token counts, redaction count).
- **Trace:** one line per model turn with tokens, cost, time and tool calls. Each turn's full text and tool calls are stored by hash and linked from that line.
- **Agent steps:** only the progress file (tool name and target, a short line per turn). Tool inputs and results are not recorded.
- **Resuming:** a completed step is skipped when its inputs hash is unchanged. The hash covers the inputs, the step definition, the prompt version and the model, but not effort or library versions. Library versions are recorded when the run starts.

## Tests

| File | Tests | What it covers |
|---|---|---|
| `src/runners/api.test.ts` | 8 | Valid answers, re-asks, read tools, the turn, cost, refusal and rate-limit stops, the plain-text nudge, prices, which models take effort, the last-turn warning. Uses a scripted model. |
| `src/runners/openai.test.ts` | 3 | The Responses API request (tools, effort, nothing stored) and the next turn, a 400 as `config-error`, local servers on chat completions. Runs against a fake HTTP server on localhost. |
| `src/runners/agent.test.ts` | 7 | Masks, the key proxy, a loaded instruction file, a missing result, feed-host allow-list, the schema format. Uses a fake container runtime. |
| `src/credit-safety.test.ts` | 10 | Key proxy restarts, agent image rebuilds, config errors, `--max-cost`, the retry budget, `factory smoke`. |
| `src/stages/e2e.test.ts` | 9 | The whole pipeline through the real core with a scripted model and fake containers. |

`factory smoke` makes a few real calls (each model, the key proxy, a tiny agent job). It is run by hand, not in `npm test`.

Not tested: the Anthropic provider's real requests, the agent's edit hook on its own, 5xx and network failures, the agent's usage on failure, the fallback price, cache markers, and stopping a step.

## Adding a vendor

Write one runner (about 150 lines) and add it to the config options. Until there is a single table of model facts, a new model also needs entries in `supportsEffort` (`api.ts`), `family()` (`types.ts`), the price table and `checkRoutes`. The runner must:
- report all usage fields on success and on every failure;
- check its answer with zod;
- map its outcomes to the statuses above;
- say how its turn and cost limits are enforced, which falls to the core if the engine has none;
- come with its own tests.

The shared conformance suite that would check this in one place is in the separate proposal.

## Known gaps

- **Error classes.** Error statuses are coarse, and the two runners map the same event differently: the turn limit, and a 429 or 5xx on the agent path.
- **Truncated answers.** An answer cut off at the output cap is re-asked like a missing one, and OpenAI calls set no output cap.
- **Agent usage.** The agent's spend is lost on a timeout or a missing result.
- **Hidden retries.** Anthropic client retries are not logged or counted.
- **Per-call limit.** The spend limit applies per call, so a step that makes several calls has no limit on its total.
- **Fallback price.** When an unknown model gets the fallback price, nothing says so.
- **OpenAI start-up check.** A missing OpenAI key silently falls back to Opus; there is no start-up check for it.
- **Stopping mid-step.** A running step can't be stopped early.
- **Denied edits.** They are recorded inside the agent but not passed back in `Result`.
- **Lint after each edit.** Not built.
- **Effort in the resume hash.** Effort is not part of it, so changing effort can reuse an old result.
- **Undecided questions:**
  - how many calls may run at once per provider;
  - what happens when a long tool loop outgrows the model's context window;
  - how the files between the host and the agent container are versioned.
