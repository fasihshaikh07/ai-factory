# Adapter layer: Stop reasons, errors, retries and timeouts

Part of [adapters.md](../adapters.md), which holds the glossary, interface and section map. Section numbers are unchanged, so a `§N` reference anywhere in the docs resolves through that map. Status legend and gap IDs (`CACHE-1` etc.) are defined there and in [decisions-and-gaps.md](decisions-and-gaps.md).

## 12. Stop reasons and errors

The runner turns vendor signals into a `Result.status` (§3). The two runner families do this differently.

### API runner

**Stop reasons (`Turn.stop`) and what the runner does with them today**

| Signal from the vendor | `Turn.stop` | Runner behavior |
|---|---|---|
| Anthropic `stop_reason: refusal`, OpenAI `message.refusal` | `refusal` | Returns `refused` at once. |
| Anthropic `max_tokens`, OpenAI `finish_reason: length` | `max_tokens` | **No special handling.** With no tool call it is treated like a plain-text answer and re-asked, so a truncated answer looks the same as a missing one. Planned: its own error class (`ERR-2`). |
| Any other stop with tool calls | `tool_use` | Calls are served or answered with an error result, then the loop continues. |
| Any other stop without tool calls | `end` | Re-ask, up to 2 times, then `bad-output`. |

**API errors before a turn exists**

| HTTP | Runner result |
|---|---|
| 429, any 5xx, Anthropic 529 (after the SDK's own 2 retries) | `rate-limited` |
| 400, 401, 403, 404 | `config-error` |
| Anything else, including network failures | `error` |

### Claude agent runner

How the Claude agent's final state maps to `Result.status`:

| Agent final state | `Result.status` |
|---|---|
| `success` | `ok`, after zod validation of the output (a schema miss is `bad-output`) |
| `error_max_turns` | `timeout` |
| `error_max_budget_usd` | `over-budget` |
| `error_max_structured_output_retries` | `bad-output` |
| API error 400, 401, 403 or 404 | `config-error` |
| API error 429 or 5xx, any other final state, a crash, or a missing result | `error` |
| An instruction file was loaded | `error` |
| The wait for the container times out | `timeout` |

### Known differences and gaps

- The agent path never returns `rate-limited` or `refused`; a 429 or 5xx there becomes `error`, so it does not get the uncounted rate-limit backoff (§17).
- `max_tokens` has no class of its own; a truncated answer is re-asked like a missing one (`ERR-2`).
- The agent's turn limit is reported as `timeout` (§18).
- There is no `cancelled` status (§18, `CANCEL-5`).
- `Result.error` is a free-text string. There are no typed error classes.

A fixed error taxonomy that both families translate into is *planned* (`ERR-1`). It is not designed yet.

---

## 17. Retries

A failed model call can be retried at four levels. The top two are recorded by the factory. The bottom two happen inside vendor libraries and are invisible to it.

| Level | Who retries | Limit | Visible in the trace and ledger? | Counted against the run? | Cost recorded? |
|---|---|---|---|---|---|
| 1. Ladder attempt | The core, after a failed step | 6 counted attempts per step, 2 per rung: retry, raise effort, stronger model, other vendor, then a human | Yes: `step#attempt`, with the failure reason | Yes | Yes |
| 2. Backoff after `rate-limited` | The core | Uncounted; wait doubles from 30 s up to a 15-minute total budget, then the run parks | Yes | No (by design) | n/a |
| 3. Re-ask inside `ApiRunner` | The runner | 2 per call | Yes: each turn shows its schema error in the trace | Counts as turns and cost | Yes |
| 4. SDK HTTP retry | The Anthropic and OpenAI client libraries (`maxRetries: 2`) | 2 per call | **No** | **No** | **No** |
| 5. Agent-engine retry | The Claude agent engine inside the container | Not known (VERIFY) | **No.** Only the final turn count and total cost come back | No | Inside the SDK's total cost, not separable |

Levels 1 to 3 are *built*. Levels 4 and 5 are hidden retries.

**What hidden retries do today**
- Level 4 retries on transient API failures before the runner sees any error. Nothing logs the retry, counts it, or adds it to usage. It shows only as a longer turn time, and as a heartbeat line if it drags on. Exactly which statuses the SDKs retry, and whether a retry after a mid-stream failure is billed, are not verified (VERIFY).
- When level 4 is exhausted, the core sees one error and then applies level 2 backoff on top. One real outage therefore costs more attempts than the core has counted, and the 15-minute budget understates the real time spent.
- Level 5 has a known structured-output retry limit inside the agent SDK (`error_max_structured_output_retries`). The retry count is not surfaced; only turns are.
- The key proxy has no retry code (searched `docker/proxy`), so it adds no retries of its own.
- `factory report` counts attempts from ledger events, so hidden retries never appear in the scorecard.

**Proposed handling (planned, not built)**
1. `RETRY-1` **Adapter-owned retries.** Set the SDK `maxRetries` to 0 and let the adapter run a small retry loop. Each retry writes a `model.retry` trace event (status, wait, attempt number) and adds to a `retries` count reported with the result. This stays translation plus bookkeeping: the adapter retries only transient failures and never decides policy.
2. `RETRY-2` **One budget.** Retries done inside the adapter count toward the same shared backoff budget as level 2, so one outage is not retried at two levels.
3. `RETRY-3` **Agent path.** Report the retry count the SDK exposes. Where it exposes nothing, record "unknown" explicitly rather than 0.
4. `RETRY-4` **Cheaper first step.** Keep the SDK's retries but hook the HTTP layer so each retry is at least logged. What hook the current SDK versions offer has not been checked (VERIFY).
5. `RETRY-5` **Conformance scenarios.** An injected 429 followed by success shows exactly one retry event. Repeated failures show a total that matches the trace and ledger.

The tradeoff is that an adapter-owned loop is more code to own and test than the SDK's built-in one.

---

## 18. Timeouts and cancellation

Timeouts and crash recovery are built. Cancelling a step that is already running is not.

**Timeouts (built, uneven)**

| Where | How it works | Gap |
|---|---|---|
| Step, API runner | `limits.timeoutSec` sets a deadline that is checked at the start of each turn | Checked only between turns. A hung model call is never interrupted. The SDK clients set no explicit timeout in the code, so their own defaults apply (VERIFY). |
| Step, agent runner | The runner waits for the container for `timeoutSec`, then stops and removes it and returns `timeout` | Real timeout, but the usage the agent had spent is not recorded (`USAGE-1`). |
| Container commands | The container CLI wrapper has a 600 s default and honors the wait timeout above | None known. |
| Whole run | An active-time cap (twice the expected time for the run's size), checked between steps | One step can overrun it by up to its own timeout. |
| Idle | The trace prints "still waiting on: ..." after a quiet period | Informational only. It never cancels anything. |

Default step timeouts are 900 s for thinking steps and 45 minutes for `author-tests` and `implement`. A step timeout returns status `timeout`, which the core treats like any other failed attempt on the ladder. The agent's turn limit is also reported as `timeout` today (see the stop-reason mapping).

**Cancellation (mostly not built)**
- `Job` has no abort signal and no runner accepts one. The code has no `AbortController`, no `SIGINT` or `SIGTERM` handler and no `process.on` calls.
- `factory pause` and `factory stop` append a request event to the run ledger. The executor reads that flag only at the top of its loop, between steps. A running step finishes first, so a stop can take up to the step timeout and the step keeps spending meanwhile.
- An in-flight API call cannot be cancelled. It runs until it returns or the SDK gives up.
- An in-flight agent container is not stopped early either.
- Pressing Ctrl-C ends the process without a clean shutdown. An agent container may keep running, and spending on the model API, until the next start removes it.
- A killed API call may be billed but not recorded, because usage is recorded per completed turn (VERIFY).
- There is no result status or error class for cancellation.

**Recovery after an unclean stop (built)**
1. At the next start the executor finds the in-flight step, removes every container labelled with the run, and records `step.interrupted`.
2. Interruptions count toward a limit. When it is reached, the run parks with "something in the environment is wrong."
3. A human wait is not counted as an interruption.
4. Cleanup errors are ignored if no container runtime is available.
5. The run lock keeps two executors from working on the same run.

**Proposed handling (planned, not built)**
1. `CANCEL-1` **Abort signal on `Job`.** Each runner passes it to its SDK call. The agent runner stops the container on abort. Adapters translate the signal and report the result; they do not decide when to cancel.
2. `CANCEL-2` **Signal handlers.** `SIGINT` and `SIGTERM` abort the current step, write `step.interrupted`, remove the run's containers and exit.
3. `CANCEL-3` **Wake the executor for `pause` and `stop`,** for example through a signal to the recorded process or a watched file, so they no longer wait for the step to end.
4. `CANCEL-4` **In-flight deadlines.** Set an explicit timeout on the SDK clients and enforce the step deadline while a call is in flight, not only between turns.
5. `CANCEL-5` **A `cancelled` status and error class,** with usage reported for whatever was spent. The core treats it as neither a failure on the ladder nor a counted attempt.
6. `CANCEL-6` **Conformance scenarios.** An abort during a turn returns `cancelled` promptly, reports usage, and leaves no container behind. A hung call ends at the deadline.

**Limits of this design**
- Abort can only stop the factory's side. The vendor may still finish and bill the request.
- Stopping mid-step discards partial work in a coding step, so the worktree must be reset or reused on purpose (a decision for the executor, not the adapter).
- Adapters must not swallow an abort as a retryable error. Retry loops (see "Retries") check the signal first.
