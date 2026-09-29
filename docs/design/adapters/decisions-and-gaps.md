# Adapter layer: Decisions and gap register

Part of [adapters.md](../adapters.md), which holds the glossary, interface and section map. Section numbers are unchanged, so a `§N` reference anywhere in the docs resolves through that map. Status legend and gap IDs (`CACHE-1` etc.) are defined there and in [decisions-and-gaps.md](decisions-and-gaps.md).

## 28. Decisions and alternatives

| Decision | Reason | Section |
|---|---|---|
| Split thinking steps (API runner) from coding steps (agent runner) | Coding needs a loop of edits, tests and retries that is hard to build well and that vendors already ship. For thinking steps that loop is unnecessary overhead, so calling the model directly is cheaper and works with any vendor. | §2 |
| Reuse vendor coding engines rather than build one | Safe file editing and context handling are what these engines do best; rebuilding them would be worse and slower. | §2 |
| Use a vendor engine only as the hands, inside the factory's gates, rather than running Claude Code as a whole | Claude Code alone is one vendor and one session that approves its own work. | §7 |
| Two libraries inside `ApiRunner` | Ollama, vLLM and LM Studio speak the OpenAI API format, so one `openai` client covers them all: fewer dependencies and fewer surprises. | §4 |
| No temperature, seed or other sampling knobs in `Job` | Determinism comes from the gates, not from sampling; a step that needs a sampling setting should be a deliberate design change. | §20 |

Not recorded yet (`DEC-1`):
- Why a gateway (such as LiteLLM) or a unified SDK was not used for provider access.
- Why `tool_choice` is `auto` rather than forcing `submit_result`.
- Which OpenAI API the OpenAI-style provider targets, and why.
- Why secrets are redacted rather than the call being blocked.

---

## 29. Gap register

Every planned item and open question in this document, with a stable ID. Status is *planned* (a design exists here), *gap* (a known problem with no design yet) or *open* (not documented yet).

| ID | Item | Section | Status |
|---|---|---|---|
| `CORE-1` | Move turn, cost and deadline enforcement into the core for runners without native caps | §7 | planned |
| `AGENT-1` | `PostToolUse` lint hook after each edit | §6 | planned |
| `AGENT-2` | Surface `deniedEdits` in `Result` | §11 | gap |
| `RUN-1` | CodexRunner; enables the other-vendor ladder rung | §4 | planned |
| `RUN-2` | JcodeRunner | §4 | planned |
| `RUN-3` | Bedrock and Vertex in `ApiRunner` | §4 | planned |
| `RUN-4` | Pass pack images to runners | §9 | planned |
| `ERR-1` | Fixed error taxonomy that both runner families translate into | §12 | planned |
| `ERR-2` | Separate class for truncation at `max_tokens` | §12 | planned |
| `USAGE-1` | Record agent usage on timeout or a missing result file | §15 | gap |
| `CACHE-1` | Show a cache hit rate per step and turn; warn on none | §16 | planned |
| `CACHE-2` | Verify the conversation cache marker; remove the type cast | §16 | planned |
| `CACHE-3` | Decide how parallel calls use the cache | §16 | planned |
| `CACHE-4` | Record caching facts in the capability registry | §16 | planned (needs `REG-1`) |
| `CACHE-5` | Use the OpenAI cache hint if it suits the pack layout | §16 | planned |
| `CACHE-6` | Keep the prefix stable on purpose, with a test | §16 | planned |
| `CACHE-7` | Caching tests | §16 | planned |
| `RETRY-1` | Adapter-owned retries with SDK retries off | §17 | planned |
| `RETRY-2` | One shared backoff budget for adapter and core retries | §17 | planned |
| `RETRY-3` | Report the agent path's retry count, or "unknown" | §17 | planned |
| `RETRY-4` | Interim: log each SDK retry | §17 | planned |
| `RETRY-5` | Retry conformance scenarios | §17 | planned |
| `CANCEL-1` | Abort signal on `Job` | §18 | planned |
| `CANCEL-2` | `SIGINT` and `SIGTERM` handlers | §18 | planned |
| `CANCEL-3` | Wake the executor for `pause` and `stop` | §18 | planned |
| `CANCEL-4` | In-flight deadlines and explicit SDK timeouts | §18 | planned |
| `CANCEL-5` | `cancelled` status with usage | §18 | planned |
| `CANCEL-6` | Cancellation conformance scenarios | §18 | planned |
| `PARAM-1` | One capability table per model | §20 | planned (part of `REG-1`) |
| `PARAM-2` | Trace every dropped or changed knob | §20 | planned |
| `PARAM-3` | Fail early on impossible settings | §20 | planned (needs `REG-1`) |
| `PARAM-4` | Keep `Job` small; add only neutral knobs | §20 | planned |
| `PARAM-5` | Parameter mapping conformance scenarios | §20 | planned |
| `REG-1` | Capability registry and start-up checks, including credential checks for every provider in place of the silent Opus fallback | §21, §5 | planned |
| `DET-1` | Record what ran: model version, effort, output cap, changed parameters | §22 | planned |
| `DET-2` | Widen the resume hash | §22 | planned |
| `DET-3` | Record and replay at the provider seam | §22 | planned |
| `DET-4` | Optional neutral sampling knob | §22 | planned |
| `DET-5` | Tie agent runs to their image digests | §22 | planned |
| `DET-6` | Determinism conformance scenarios | §22 | planned |
| `DET-7` | Pin the build environment in the resume hash | §22 | planned |
| `DET-8` | Record cache tokens and retry count per turn | §22 | planned (needs `RETRY-1`) |
| `TEST-1` | Conformance suite | §26 | planned |
| `TEST-2` | Provider request and response tests | §26 | planned |
| `TEST-3` | Agent hook tests | §26 | planned |
| `TEST-4` | Replay tests | §26 | planned (needs `DET-3`) |
| `TEST-5` | Live suite behind an environment variable | §26 | planned |
| `TEST-6` | Registry checks | §26 | planned (needs `REG-1`) |
| `STREAM-1` | Document streaming behaviour | §13 | open |
| `CTXW-1` | Document context window management | §14 | open |
| `CONC-1` | Document concurrency and rate-limit coordination | §19 | open |
| `OBS-1` | Trace redaction, storage, retention and naming | §23 | open |
| `SEC-1` | Vendor data terms, tool input validation, redaction policy, ledger retention | §24 | open |
| `WIRE-1` | Agent wire contract schemas and versioning | §25 | open |
| `DEC-1` | Record the decisions listed in §28 | §28 | open |
