# Adapter layer: Usage, cost, caching and parameter mapping

Part of [adapters.md](../adapters.md), which holds the glossary, interface and section map. Section numbers are unchanged, so a `§N` reference anywhere in the docs resolves through that map. Status legend and gap IDs (`CACHE-1` etc.) are defined there and in [decisions-and-gaps.md](decisions-and-gaps.md).

## 15. Usage and cost

Usage is reported by each runner in one shape, recorded by the core as ledger events, and enforced by caps at three levels. All costs are **estimates in USD**; the factory never reads a bill.

**What a runner reports (`Result.usage`, built)**

| Field | Meaning |
|---|---|
| `inputTokens`, `outputTokens` | Non-cached input and output tokens |
| `cacheRead`, `cacheWrite` | Cached input tokens read and written |
| `turns` | Model turns used |
| `wallMs` | Wall-clock time of the run |
| `estUsd` | Estimated cost in USD |

**How each runner produces it**

| | `ApiRunner` (built) | `ClaudeAgentRunner` (built) | Codex, jcode (planned) |
|---|---|---|---|
| Source of tokens | Usage block of every model response | The agent's final result file | Whatever the engine reports (VERIFY) |
| Source of cost | The factory's own price table (`src/runners/pricing.ts`) applied to those tokens | The SDK's own total cost (`total_cost_usd`), not the factory's table | Must be computed by the core: no native cap found for Codex |
| When it is reported | After every model call, through `onUsage`, so spend reaches the ledger even if the runner later crashes | Once, when the container finishes | Same as the Claude agent unless the engine streams usage |
| Per-step cap | Checked after every turn against `maxUsd`; over the cap returns `over-budget` | `maxBudgetUsd` enforced inside the container by the SDK | Core timer only (see the per-runner table) |
| Lost on failure? | No: accumulated usage is kept on timeout and over-budget | **Yes on timeout or a missing result file**: empty usage is returned, so the spend is not recorded | n/a |

**Price table (`src/runners/pricing.ts`, API runners only)**
- USD per million tokens for input, output, cache read and cache write. Built-in entries exist for the Claude models the factory routes to, with a cache date noted in the file.
- A project can add or override prices with the `prices:` block in its project file. This is needed for GPT models, which have no built-in price.
- An unknown model is priced at the most expensive fallback ($10 in, $50 out per million tokens), so caps stay safe but can trigger early.
- `ollama/*` models cost 0.
- OpenAI usage is normalized: cached tokens are subtracted from input, and `cacheWrite` is always 0.

**How the core records it (built)**
1. The core supplies `ctx.usage`. Each call writes a `usage` event to the run ledger with the model, input, output, cache read and cache write tokens, and `gen_ai.usage.cost_usd`.
2. Replaying the ledger adds these up into the run's total cost. Nothing is stored twice.
3. `factory report` reads the same events for the per-step cost scorecard.

**Where limits apply**

| Level | Limit | Enforced by | On hit |
|---|---|---|---|
| Step | `maxUsd`: default $2 for thinking steps, $4 for `author-tests` and `implement` | The runner (API: per turn; agent: inside the container) | `over-budget` result |
| Run | Class and size based cap, never below $10; `--max-cost` can only lower it | The core, between steps (`checkCaps`) | Run parks with a waiver card a human can approve |
| Provider | None: the key proxy does not track spend | n/a | n/a |

Consequences to know about:
- The run cap is checked between steps, so one step can spend up to its step cap on top of the run cap.
- API and agent costs come from different price sources, so the run total mixes two estimation methods.
- Tokens and cost are never reconciled with the provider. A wrong price table produces a wrong cap.
- Usage lost when an agent times out is a known gap (`USAGE-1`).

**What a new runner must provide**
- Report all seven usage fields, on success and on every failure path. Reporting `0` for something unknown must be a deliberate choice, not a default.
- Report cost in the same units as the price table, or state which source it uses and add it to this section.
- Support the step cap natively or be capped by the core.

*Status of tests:* `api.test.ts` covers prices, cost calculation for a Claude model and a free local model, the cost-cap stop and the `onUsage` call. Nothing tests agent usage on failure, price fallbacks for unknown models, or that ledger totals match the sum of runner usage. No planned test layer covers them yet.

---

## 16. Prompt caching

Caching lets a vendor reuse the start of a prompt it has already processed, at a fraction of the input price. In the price table, a Sonnet 5 cache read costs one tenth of normal input and a cache write costs 1.25 times normal input, so caching pays off only when a prefix is read again. The factory sets it up for Anthropic tool loops. It does not verify that it works and does not measure how well.

**How each runner handles it**

| | Anthropic API (built) | OpenAI-style API (built) | Claude agent (built) |
|---|---|---|---|
| Control | Explicit cache markers on the system prompt and on the growing conversation | None: the vendor caches matching prefixes automatically | Managed by the SDK; dynamic prompt sections are excluded to keep the prefix stable |
| Request order | Tools, then system, then messages, so the stable part comes first | System (as a `developer` message), then user | Not visible to the factory |
| Reported in usage | `cacheRead` and `cacheWrite` | `cacheRead` only; `cacheWrite` is always 0 | Both, from the final result |
| Cache hints | Not applicable | No `prompt_cache_key` or similar hint is used | Not applicable |
| Tested | No | No | No |

The conversation marker is a top-level `cache_control` request field. The code casts the request past the SDK's types to send it, which suggests the SDK version does not know the field. Whether the API honors it is not verified (VERIFY).

**Where caching helps and where it does not (design reading, not measured)**
- **Multi-turn tool loops in one step:** the system prompt and earlier turns are read again on every turn. This is the main benefit.
- **Retries of the same step:** the tools and system prompt are unchanged, so a retry inside the cache lifetime can share the prefix. A ladder move to a different model or effort starts cold, and a retry after a human wait or a long backoff likely misses because the lifetime is short (about five minutes, VERIFY).
- **Parallel calls:** the pipeline starts several calls at once (`Promise.all`: three clarify readings, several spec drafts). A cache entry usually helps only calls that begin after the first response, so parallel calls likely each pay the write cost with no read benefit (VERIFY).
- **Across steps:** no sharing. The tool list comes first in the prefix and includes a per-step `submit_result` schema, so two steps differ from the first token.
- **Small prompts:** vendors have a minimum prompt length for caching that varies by model (VERIFY). Small steps such as intake may not cache at all.
- **Local models:** no caching is assumed.
- **Agent attempts:** every attempt starts a fresh process, and the agent's real cache effectiveness is unknown.

**What is recorded today**
- Cache read and write tokens are recorded on every model call in the run ledger and priced into the step's cost.
- The run report sums cache reads per step but shows them added to input in one column, ignores cache writes, and prints no hit rate. Nothing warns when a multi-turn step has no hits. The per-turn trace line shows input tokens with cache reads included, so the split is not visible.

**Proposed handling (planned, not built)**
1. `CACHE-1` **Show a hit rate.** For each step and each turn, compute cache reads divided by input plus cache reads plus cache writes. Put it in the trace line and the report, and warn when a multi-turn step on a caching model has none.
2. `CACHE-2` **Verify the conversation marker.** Confirm the API accepts the top-level field, or put an explicit marker on the last message instead, and remove the type cast.
3. `CACHE-3` **Decide about parallel calls.** Either send one first and the rest after it, accepting the added latency, or accept the write cost and stop counting on reads. This is a cost and latency choice for each parallel step.
4. `CACHE-4` **Record caching facts in the capability registry:** whether the model supports caching, the minimum length, and the lifetime. Small or unsupported cases are then known up front.
5. `CACHE-5` **Use the vendor hint for OpenAI** (a cache key) if the current API offers one that suits the pack layout (VERIFY).
6. `CACHE-6` **Keep the prefix stable on purpose.** Volatile content (failure lists, retry notes) goes after stable content in the user part, never into the system part or the tools. A test asserts the order.
7. `CACHE-7` **Tests:** a request carries the markers in the stable-prefix order, and a scripted provider that reports cache reads produces the expected hit rate in the trace and report.

**Limits of this design**
- The factory can only shape the prompt and read the usage numbers. Whether a hit occurs is the vendor's decision.
- A low hit rate is a signal, not an error, so it must never fail a step.
- Cache write cost is real: a step whose prefix is never read again pays more than with no caching. The hit-rate report is how that gets noticed.

---

## 20. Parameter mapping

`Job` carries only a few vendor-neutral knobs. Each adapter translates them into its vendor's parameters. The core never sees or sets a vendor parameter.

**What the core can set (`Job`)**

| Knob | Meaning |
|---|---|
| `model` | A model id string, for example `claude-sonnet-5`, `gpt-5.5` or `ollama/qwen3.6` |
| `effort` | `low`, `medium`, `high` or `xhigh` (optional) |
| `limits.maxTurns`, `limits.maxUsd`, `limits.timeoutSec` | Step limits |
| `schema` | The zod schema of the answer |

**How each adapter maps them today (built)**

| Knob | Anthropic API | OpenAI-style API | Claude agent |
|---|---|---|---|
| `model` | Passed as-is | Passed as-is; an `ollama/` prefix is stripped | Passed as-is |
| `effort` | `output_config.effort`, sent only when a hard-coded model pattern (`supportsEffort`) says the model accepts it; otherwise dropped with no note. Defaults to `high` when the model accepts it and none is set. `xhigh` is passed unchanged (VERIFY that the API accepts it). | `reasoning_effort`, sent whenever an effort is set, with **no per-model check**; `xhigh` is sent as `high` (VERIFY how non-reasoning models and local servers react) | Passed only if the same `supportsEffort` pattern passes; defaults to `high` |
| `maxTurns` | Counted by the runner | Counted by the runner | Passed to the SDK |
| `maxUsd` | Checked by the runner after each turn | Checked by the runner after each turn | Passed to the SDK as the budget |
| `timeoutSec` | Runner deadline, checked between turns | Same | Container wait |
| `schema` | `submit_result` tool | `submit_result` tool | `outputFormat: json_schema` |

**Parameters the adapters set themselves, which `Job` cannot change**

| Parameter | Anthropic | OpenAI-style | Claude agent |
|---|---|---|---|
| Output cap | `max_tokens: 32000` | Not set (server default) | Managed by the SDK |
| Tool choice | `auto` | `auto` | Managed by the SDK |
| Prompt caching | Explicit cache markers on the system prompt and the conversation | None; cached tokens are only read from usage | Managed by the SDK |
| Client retries | `maxRetries: 2` | `maxRetries: 2` | Unknown |
| Temperature, top_p, seed, stop sequences | Not set | Not set | Not set |

Temperature and similar sampling settings are not exposed on purpose. The factory's determinism comes from its gates, not from model sampling, so a step that needs a sampling setting should be a deliberate design change, not a hidden default.

**Known problems**
- Effort is gated by a regex for Anthropic and by nothing for OpenAI, so the same setting behaves differently per vendor. A model that fails the Anthropic pattern gets no effort at all and no trace note, so the ladder's "raise effort" rung then has no effect and the retry looks wasted.
- `xhigh` means `xhigh` for Anthropic and `high` for OpenAI.
- Model ids are matched exactly for pricing. A dated or aliased id falls through to the expensive fallback price and can trigger cost caps early. The vendor family is guessed from the id text.
- The output cap differs per vendor, so truncation behaves differently (see the stop-reason table).
- The mapping logic is spread across regexes and inline conditions in `api.ts`, `pricing.ts`, `claude-agent.ts` and `types.ts`.

**Proposed handling (planned, not built)**
1. `PARAM-1` **One capability table per model, owned by the adapters:** whether it accepts effort, how effort maps, output cap, structured-output support, tool support and price. A new model or vendor becomes one row. The same table feeds pricing, so ids and prices cannot drift apart.
2. `PARAM-2` **Trace every change.** When an adapter drops or alters a knob (effort unsupported, `xhigh` sent as `high`), it writes a trace note.
3. `PARAM-3` **Fail early on impossible settings.** A step routed to a model that cannot support what the step needs fails at start-up, like the existing route checks, not partway through a run.
4. `PARAM-4` **Keep `Job` small.** Vendor parameters are not added to `Job`. If a knob is needed, it is added as a neutral one and mapped in each adapter.
5. `PARAM-5` **Conformance scenarios.** Assert what each adapter sends for each effort level, using the fake providers, and that a dropped knob leaves a trace note.

The tradeoffs are upkeep (the table goes stale as vendors ship models, the same way the regex does) and start-up errors that a silent drop would have hidden.
