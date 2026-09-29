# Adapter layer: Observability and security

Part of [adapters.md](../adapters.md), which holds the glossary, interface and section map. Section numbers are unchanged, so a `§N` reference anywhere in the docs resolves through that map. Status legend and gap IDs (`CACHE-1` etc.) are defined there and in [decisions-and-gaps.md](decisions-and-gaps.md).

## 23. Observability and tracing

This section collects what other sections say about traces and records.

| What is recorded | Where | Section |
|---|---|---|
| Each API-runner tool call: name, input, duration, result size, error flag, result text | `onTurn`, into the trace | §11 |
| Each model turn as a blob, with model, usage and cost | Ledger, referenced from the trace | §22 |
| Usage per model call: model, input, output, cache read and cache write tokens, `gen_ai.usage.cost_usd` | `usage` ledger events | §15 |
| Agent progress: tool name and short target per call; a per-turn line with token counts and short text | Progress file read by the host | §11 |
| Idle notice, "still waiting on: ..." | Trace | §18 |
| Pack manifest: token counts, redaction count, pack hash | Ledger | §9 |
| Per-step cost scorecard | `factory report`, from usage events | §15 |

Known gaps, described in their own sections:
- Agent tool inputs and results are not recorded (§11).
- Hidden SDK retries are not visible (§17, `RETRY-1`, `RETRY-4`).
- The trace line counts cache reads as input, and the report shows no hit rate (§16, `CACHE-1`).
- `deniedEdits` is recorded but not surfaced in `Result` (§11, `AGENT-2`).

Questions to answer (`OBS-1`): Is the result text in the trace the redacted text the model saw (VERIFY)? Where are traces stored, and for how long? Should the other trace and usage fields follow one naming convention, as `gen_ai.usage.cost_usd` does?

---

## 24. Security and data handling

This section collects the controls described elsewhere into one view.

| Control | Applies to | Section |
|---|---|---|
| Keys live only in `~/.factory/.env`. The agent reaches the model through a key proxy and never holds the key. | Claude agent | §6 |
| Internal container network; no web or MCP tools | Claude agent | §6, §11 |
| Read-only masks over git metadata, agent instruction files, tracked secret files and no-go folders | Claude agent | §6 |
| `settingSources: []`, and the step fails if an instruction file was loaded | Claude agent | §6, §12 |
| `PreToolUse` hook on edit paths and Bash commands (a convenience, not a boundary) | Claude agent | §11 |
| Diff gates: file scope, locked tests, protected files, secrets | Coding steps | §7 |
| Read-only repo tools over a snapshot; paths outside the repo, secret paths and no-go paths refused | API runner | §11 |
| Redaction of packs and tool results | All | §7 |
| Untrusted sections never in the system prompt or in a step that can write | All | §7 |

**What reaches a vendor.** For the API runner, the pack and tool results, after redaction, go to the configured model API. For the Claude agent, whatever the engine reads in the worktree goes to Anthropic through the key proxy. Local models (Ollama, vLLM, LM Studio) keep content on the machine.

Questions to answer (`SEC-1`):
- What are each vendor's data retention and training terms for the keys the factory uses?
- How are model-supplied tool inputs other than paths validated, for example the `search` regex pattern (VERIFY)?
- Blocking a call on a redaction hit is not implemented (§7). Is redaction alone the intended policy?
- The ledger holds full redacted turns (§22). What are its permissions and retention?
