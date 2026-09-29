# Adapter layer: Open topics

Part of [adapters.md](../adapters.md), which holds the glossary, interface and section map. Section numbers are unchanged, so a `§N` reference anywhere in the docs resolves through that map. Status legend and gap IDs (`CACHE-1` etc.) are defined there and in [decisions-and-gaps.md](decisions-and-gaps.md).

## 13. Streaming *(open)*

This document does not yet state whether the providers stream responses. The answer affects several other sections:
- **Deadlines:** a streamed call can be stopped partway; today the step deadline is checked only between turns (§18).
- **Cancellation and usage:** what is spent and recorded when a call dies partway (§15, §18).
- **Long outputs:** the Anthropic SDK may warn about or refuse non-streaming requests with a large `max_tokens`. Confirm the behaviour at the current 32,000 cap (VERIFY).
- **Trace:** streaming allows progress lines during a long turn (§23).

Questions to answer (`STREAM-1`): Does each provider stream today? If not, is that a decision (record it in §28) or a default? How are partial responses and their usage handled?

---

## 14. Context window management *(open)*

What is known today, from other sections:
- The core builds a pack per step with only the files that step needs (§7), and its manifest records token counts (§9).
- Each repo tool has its own limit: `read_file` 400 lines per call, `search` 50 hits, `repo_map` a 3000-token budget (§11). There is no cap on the total size of tool results in a conversation.
- The output cap is 32,000 tokens on Anthropic and not set on the OpenAI-style path (§20).
- A start-up check that the step's pack budget plus the output cap fits the model's context window is planned (§21, `REG-1`).
- An API 400 maps to `config-error` (§12). Whether a context-overflow error arrives as a 400 is not verified (VERIFY).

Questions to answer (`CTXW-1`): How is the pack budget set per step? Are tokens counted before a call is sent? What happens when a multi-turn tool loop outgrows the window: an error, trimming of older tool results, or a failed step? Which `Result.status` should that produce?

---

## 19. Concurrency and rate limits *(open)*

What is known today, from other sections:
- The pipeline starts several calls at once with `Promise.all`, for example three clarify readings and several spec drafts (§16).
- `rate-limited` makes the core back off, doubling from 30 s within a 15-minute budget, without counting an attempt (§17).
- The SDK clients retry up to twice on their own before the runner sees an error (§17).
- The run lock keeps two executors off the same run (§18), and only one run executes per repo at a time (README).

Questions to answer (`CONC-1`): Is there a limit on concurrent calls per provider? When parallel calls hit a rate limit together, do they back off independently, and does that interact with the 15-minute budget? Should a shared per-provider limiter exist, and in which layer?

---

## 25. Agent wire contract *(open)*

The Claude agent runner talks to its container through files, which makes them an interface between the host code and a separately built image.

What is known today:
- **Input file:** the system text, the task text, the JSON schema, the limits and the file scope (§9).
- **Result file:** the final state, the output and usage, including the SDK's `total_cost_usd` (§12, §15).
- **Progress file:** tool names and targets, and per-turn token counts (§23).
- **Image:** `factory-agent:dotnet8`, built from `docker/agent`; its fingerprint is tested (§26). The hook lives in `docker/agent/run-agent.mjs`.

Questions to answer (`WIRE-1`): Where are the schemas of the three files defined? Do they carry a version? What happens when the host and a rebuilt image disagree? Do the file scope and protected patterns in the input come from the same source as the core diff gates?
