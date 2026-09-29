# Adapter layer: Messages, structured output and tool calling

Part of [adapters.md](../adapters.md), which holds the glossary, interface and section map. Section numbers are unchanged, so a `§N` reference anywhere in the docs resolves through that map. Status legend and gap IDs (`CACHE-1` etc.) are defined there and in [decisions-and-gaps.md](decisions-and-gaps.md).

## 9. Message and content model

The core never builds vendor messages. It hands a runner a `ContextPack` and a schema, and each runner turns that into whatever its vendor expects. The two runner families do this very differently.

**What the core provides (`ContextPack`, built, `src/contracts/pack.ts`)**

| Field | Meaning |
|---|---|
| `system` | Trusted instructions. Untrusted content may not be placed here. |
| `user` | The task and its supporting sections, as one string. |
| `pointers` | `{ path, reason }` list: files the model may read. Not sent as content. |
| `tools` | Names of read-only repo tools this step may call (`read_file`, `search`, `repo_map`). |
| `images` | Hashes of attached images. *Accepted by the pack but not read by any runner today* (planned). |
| `manifest` | Audit record: token counts, redaction count, pack hash. Never sent to the model. |

There is one system string and one user string. No multi-part or multi-role input is built by the core.

**API runners (built): a normalized turn model, private to `ApiRunner` (`src/runners/api.ts`)**

`ApiRunner` talks to a `Provider` through four types, so tests can script a model:

| Type | Fields |
|---|---|
| `ToolSpec` | `name`, `description`, JSON-schema `schema` |
| `ToolCall` | `id`, `name`, `input` |
| `Turn` | `calls`, `text`, `stop` (`tool_use`, `end`, `max_tokens` or `refusal`), `usage` |
| `Conversation` | `next()` returns a `Turn`; `toolResults(...)` and `say(text)` add the next user message |

The runner always adds one extra tool, `submit_result`, whose input schema is the step's schema. The answer is the `input` of that call, validated with zod. Plain text is never accepted as the answer: the runner sends "Call the submit_result tool" and counts it as one of the two re-asks.

How each provider maps this:

| | `AnthropicProvider` | `OpenAIProvider` (also Ollama, vLLM, LM Studio via a base URL) |
|---|---|---|
| System | `system` block with a cache marker | a `developer` message |
| Tools | `tools` with `input_schema`, `tool_choice: auto` | `function` tools, `tool_choice: auto` |
| Assistant turn is kept as | the full content blocks, unchanged, so thinking blocks go back to the model | the raw assistant message |
| Tool result | a `tool_result` block with `is_error` | a `tool` message; errors are prefixed with `ERROR:` in the text |
| Effort | `output_config.effort`, only for models that accept it | `reasoning_effort` (`xhigh` is sent as `high`) |
| Output cap | `max_tokens: 32000` | none set |
| Bad tool arguments | n/a (the SDK returns parsed input) | unparsable JSON becomes `{ __unparsable: true }`, which fails the schema and triggers a re-ask |
| Caching | prompt and conversation cache markers | reports cached tokens only |

*VERIFY:* that local OpenAI-compatible servers return `tool_calls` reliably for every model. The doc assumes so; nothing checks it.

**Agent runners (built for Claude): opaque conversation**

An agent runner sends `system`, the task text, the JSON schema, the limits and the file scope in one input file, and reads back one result file. The conversation, tool calls and thinking stay inside the vendor engine. The core sees only the final result plus a progress feed for the trace. Consequences:
- The core cannot resume, replay or inspect an agent's messages. `sessionId` is audit-only.
- Every agent step starts fresh. Retries pass the failure list in the new task text.
- Images are not passed.

---

## 10. Structured output

Every step returns one JSON object that must pass the step's zod schema. zod is the single schema source.

| | ApiRunner (built) | ClaudeAgentRunner (built) | CodexRunner (planned) | JcodeRunner (planned) |
|---|---|---|---|---|
| Mechanism | `submit_result` tool whose input schema is the step's schema | `outputFormat: json_schema` | `outputSchema` | `runStructured()` |
| Validation | zod, on every `submit_result` call | zod, once, on the final result | not designed | not designed |
| On a schema miss | The errors go back as a tool error result and count as one of two re-asks; then `bad-output` | `bad-output`. The engine's own retries end in `error_max_structured_output_retries` | not designed | not designed |
| Plain-text answer | Never accepted. The runner replies "Call the submit_result tool", which counts as a re-ask | n/a | n/a | n/a |

Related details:
- `tool_choice` is `auto` on both providers, so the model may answer in plain text first (§11).
- Unparsable OpenAI tool arguments become `{ __unparsable: true }`, which fails the schema and triggers a re-ask (§9).
- An answer truncated at the output cap is currently indistinguishable from a missing answer (§12, `ERR-2`).
- Whether a model supports native structured output is a planned registry field, `structuredOutput` (§21).

---

## 11. Tool calling

Two separate tool systems exist, one per runner family. They share no code and have different rules.

**API runners (built): three read-only repo tools, served by the core**

The model never touches the filesystem. `ApiRunner` offers the tools listed in `pack.tools` plus `submit_result`, and answers each call itself through `RepoTools` (`src/context/tools.ts`) over a snapshot of the repo at the run's base commit.

| Tool | Input | Limits |
|---|---|---|
| `read_file` | `path`, optional `start`, `end` | 400 lines per call, numbered; a hint says which `start` to ask for next |
| `search` | `pattern` (regex, case-insensitive), optional `glob` | 50 hits, each line cut to 200 characters; binary files skipped |
| `repo_map` | optional `focus` paths | 3000-token budget |

Rules the tools enforce:
- Paths outside the repo, secret paths and configured no-go paths are refused, and files not in the snapshot do not exist.
- Every result is passed through the redactor before the model sees it.
- No write, shell or network tool exists.
- A failed call returns a normal result whose text starts with `ERROR:`. It does not set the vendor's error flag. Only an unavailable tool or a schema failure on `submit_result` sets it.

How the runner handles a turn with tool calls:
1. Calls are answered in order, and every call gets a result.
2. A name that is neither in `pack.tools` nor `submit_result` gets an error result, "Tool X isn't available", and the loop continues.
3. `submit_result` with input that passes the schema ends the run. A second valid `submit_result` in the same turn gets "Already accepted." Other calls in that turn are still answered.
4. `submit_result` with invalid input gets the schema errors back as an error result and counts as one of the two re-asks.
5. If the step asked for tools but no `RepoTools` was supplied, `run` throws before any model call.
6. The loop ends at `maxTurns`, the cost cap or the deadline. There is no cap on the number of calls per turn and no cap on the total size of results beyond the per-tool limits.

`tool_choice` is `auto` on both providers, so the model may answer in plain text instead of calling `submit_result`; that is handled by the re-ask. Forcing the tool is possible but not used.

Tool calls are traced: `onTurn` receives each call's name, input, duration, result size, error flag and result text.

**Agent runners (built for Claude): the engine's own tools, gated by the factory**

The Claude agent gets the SDK's built-in tools: `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Bash`. No web, MCP or other tools are offered, and permissions run in `dontAsk` mode so nothing prompts. The factory does not define or serve these tools. It gates them in three places:

| Gate | What it does |
|---|---|
| Container | Internal network, read-only masks over git metadata, agent instruction files, tracked secret files and no-go folders. This is the real boundary for network and secrets. |
| `PreToolUse` hook | For `Write`, `Edit`, `MultiEdit`, `NotebookEdit`: denies a path that is outside the workspace, matches a protected pattern (locked tests, factory config, CI), or is outside the task's file scope. For `Bash`: denies commands matching git, curl, wget, nc, ssh, `dotnet add` or `nuget`, and `npm install`. Denied edits are recorded as `deniedEdits`. |
| Core diff gates | After the step, the core checks the diff against the file scope, locked tests, protected files and secrets. |

Known limits of the hook:
- It only inspects the edit tools. A `Bash` command that writes a file (for example a shell redirect) is not checked by the hook; the core diff gates catch it afterwards.
- The `Bash` check is a text match, so it is a convenience, not a boundary. The network block comes from the container.
- `deniedEdits` is recorded but the runner does not surface it in `Result` yet.

Tracing: the host reads a progress file while the agent works. It shows the tool name and a short target for each call, and a per-turn line with token counts and a short text. Tool inputs and results are not recorded.

**What a new runner must provide**

Codex and jcode each bring their own tools. Each needs its own gating plan in the per-runner table, and must not be given tools beyond what the step allows. For `api`-style runners the tool set is fixed at the three repo tools plus `submit_result`.

*Status of tests:* `api.test.ts` covers serving read tools, refusing an unavailable tool and re-asking on a schema error. Nothing tests path escapes, secret paths, result caps, duplicate `submit_result` calls, or the agent hook. These belong in the conformance suite (`TEST-1`) and the hook tests (`TEST-3`).
