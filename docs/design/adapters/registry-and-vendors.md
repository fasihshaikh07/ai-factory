# Adapter layer: Capability registry and adding a vendor

Part of [adapters.md](../adapters.md), which holds the glossary, interface and section map. Section numbers are unchanged, so a `§N` reference anywhere in the docs resolves through that map. Status legend and gap IDs (`CACHE-1` etc.) are defined there and in [decisions-and-gaps.md](decisions-and-gaps.md).

## 21. Capability registry *(planned)*

**Goal:** a request that can never work fails on the developer's machine, with a plain message, before any model is called and before any earlier step has spent money.

**Status today.** No registry exists. Model facts are spread across `supportsEffort` (`api.ts`), the price table and `priceOf` (`pricing.ts`), `family()` (`types.ts`), the route checks (`routing.ts`) and inline conditions in each provider. Only route shape is checked at start-up (thinking steps use `api`, coding steps use an agent runner, unbuilt runners are rejected, Claude models need a key). Model and runner match, unknown ids, context window, tool support and OpenAI credentials are not checked, so those failures appear late or silently degrade. See "Parameter mapping" for the symptoms.

**One entry per model**

| Field | Used for |
|---|---|
| `id` and aliases | Exact lookup. Dated or aliased ids resolve to one entry instead of falling through to a guess. |
| `family` | Vendor family for the reviewer-differs-from-implementer rule, replacing the guess from the id text. |
| `runners` | Which runners can drive this model: `api`, `claude-agent`, `codex`, `jcode`. A route with a runner not in the list is rejected. |
| `credential` | Which key or base URL is needed (for example `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OLLAMA_BASE_URL`). |
| `effort` | Whether effort is accepted, and the map from `low`, `medium`, `high` and `xhigh` to the vendor's values. |
| `outputCap` | The output token cap the adapter sets, so truncation behaves the same for every model. |
| `contextWindow` | Checked against the step's pack budget plus the output cap. |
| `tools` | Whether tool calling works reliably. Steps that use repo tools need this. |
| `structuredOutput` | `native`, `tool` (the `submit_result` approach) or `none`. |
| `images` | Whether image input is accepted. |
| `price` | Input, output, cache read and cache write, per million tokens. |
| `verified` | Date and source of the values. Entries older than a set age produce a warning. |

The registry would replace `supportsEffort`, `family()`, the price table and the per-provider constants. Adapters read it when mapping parameters, so a dropped or changed setting becomes a recorded decision, not a silent one.

**Checks that run locally (planned)**

Run at start-up, once, over every route the project can use, before a run is created. They make no API calls.

| Check | Example failure message |
|---|---|
| The model has a registry entry | "`gpt-5.7` is not in the registry. Add it under `models:` in the project file." |
| The runner is allowed for the model | "`implement` uses `claude-agent` but `gpt-5.5` cannot run there." |
| The credential for the model's provider is present, for every provider, not just Anthropic | "`critic` needs `OPENAI_API_KEY` in `~/.factory/.env`." |
| The step's pack budget plus output cap fits the context window | "`ground` needs about 40,000 tokens; `ollama/qwen3.6` allows 32,768." |
| The step's needs are supported: tools for steps with repo tools, images if the pack has any | "`specify` reads files but `ollama/x` has no reliable tool calling." |
| The requested effort is supported, or the fallback is stated | "`intake` sets effort `low`; `claude-haiku-4-5` ignores it. Sent without effort." |
| Escalation and other-vendor rungs point at usable models | "`implement` escalates to `claude-opus-9`, which is not in the registry." |
| A missing OpenAI key on a `gpt-*` step is an error, or an explicit opt-in to the Opus fallback | Replaces today's silent reroute. |

Failures list every problem at once, in plain words, and refuse to start. A warning does not block a run.

**Unknown and local models**
- An unknown model fails the check. It does not get a guessed price. This removes the expensive-fallback price problem.
- Local models (`ollama/*`, vLLM, LM Studio) must be declared, because window, tool support and structured output vary per model and per server. A project adds them under a `models:` block with the same fields. The project's entries override built-in ones, so a new vendor model works without waiting for a factory release.

**What the registry cannot know**
- Whether a vendor accepts a value today. The values are maintained by hand and can go stale. The `verified` date and an optional live probe reduce this: `factory smoke` already makes small real calls, and a probe mode could confirm each declared model answers. That probe costs a little and is optional.
- Whether a model's answers are good enough for a step. That stays a quality question for evals, not a capability flag.

**Tests (planned)**
- Every model in the default routes has a complete entry.
- Every entry has all required fields, and prices, windows and caps are positive.
- Each start-up check has a failing example and a passing example.
- Adapters send what the registry says for each effort level (see the parameter mapping scenarios).

**Tradeoffs.** The table needs upkeep as vendors ship models, and a stale entry can block a model that works. The project override and the warning on old entries soften that. Failing at start-up means some setups that limped along before now stop with a message, which is intended.

---

## 27. Adding a new vendor

Write one new runner (~150 lines), add it to the config options, and run the **conformance test**: 5 fixed mini-jobs every runner must pass (return valid JSON, respect the folder, respect the timeout, report usage, refuse a protected-file edit). Until the capability registry exists (`REG-1`), a new vendor also needs entries in `supportsEffort`, `family()`, the price table and `checkRoutes` (see §21).

*Status:* the conformance test is *planned* (`TEST-1`) and does not exist yet. Today `api.test.ts` and `agent.test.ts` test each runner separately with their own fakes. The error taxonomy the runners translate vendor failures into is also planned (`ERR-1`).

**Runner requirements collected from this document.** A new runner must:
- Follow the tool rules in §11 ("What a new runner must provide") and have its own row in the per-runner table (§6).
- Report usage as described in §15 ("What a new runner must provide"), on success and on every failure path.
- Return structured output validated with zod (§10) and map its outcomes to `Result.status` (§12).
- For agent runners, define its wire contract (§25) and how the core caps it if it has no native cap (§7, `CORE-1`).
- Ship with its conformance harness and mapping tests (§26).
