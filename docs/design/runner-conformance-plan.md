# Runner Conformance Suite and Error Taxonomy: Plan (2026-09-30)

Status: draft for team review. No code has been written. `adapters.md` has been updated (also a draft) to match the code and to mark each item built or planned. This plan uses the same terms.

Related: `adapters.md` (adapter design), `src/runners/types.ts` (the `Runner` interface).

---

## 1. Goal

Every runner (`api`, `claude-agent`, and later `codex` and `jcode`) must behave the same way through the `Runner` interface. Two things are missing today:

1. **A conformance suite.** `adapters.md` promises "5 fixed mini-jobs every runner must pass". It does not exist. Each runner has its own tests with its own fakes, so a new runner has no gate.
2. **An error taxonomy owned by the adapters.** Each adapter should translate vendor failures into one factory taxonomy. The core should read only that taxonomy, never vendor errors or ad hoc status strings.

---

## 2. Current state (evidence)

### 2.1 Where errors are defined

| Layer | Type | Values |
|---|---|---|
| Runner result | `ResultStatus` (`src/runners/types.ts:20`) | `ok`, `bad-output`, `timeout`, `over-budget`, `rate-limited`, `refused`, `config-error`, `error` |
| Vendor errors | thrown inside providers | `RateLimitedError`, `ConfigError(status)` in `api.ts`; agent `out.status` string plus `apiErrorStatus` |
| Core failure ladder | `FailureCategory` (`src/gates/ladder.ts:2`) | `safety`, `locked-test`, `rate-limit`, `other` |
| Core step outcome | `StepOutcome` (`src/stages/framework.ts`) | `done`, `wait`, `fail(category)`, `park`, `close` |

### 2.2 Findings

Contract differences between the two existing runners:

1. **Turn-limit status differs.** `ApiRunner` returns `bad-output` when `maxTurns` runs out (`api.ts:275`). `ClaudeAgentRunner` maps the agent's `max-turns` to `timeout` (`claude-agent.ts:188`).
2. **Timeout is only checked between turns in `ApiRunner`** (`api.ts:219`). A hung `convo.next()` is never interrupted. The agent runner enforces it through `rt.wait(id, timeoutSec)`.
3. **Usage on failure paths differs.** `ApiRunner` keeps accumulated usage on timeout and over-budget. `ClaudeAgentRunner` returns empty usage on timeout and on a missing result (`claude-agent.ts:170-171`), so spend from a failed agent run may not reach the ledger.
4. **The agent runner never emits `refused` or `rate-limited`.** Any unknown agent status becomes `error`.
5. **Preconditions throw instead of returning a `Result`.** `ApiRunner` throws when a step needs repo tools and none were given. `ClaudeAgentRunner` throws without `workdir`. The contract does not say which is right.
6. **"Refuse a protected-file edit" is only partly testable at runner level.** The enforcement is the in-container hook plus the core's post-turn diff check. The runner can still be tested for what it reports. The agent output already carries `deniedEdits` (`AgentOut`, `claude-agent.ts:54-65`), but `ClaudeAgentRunner` ignores it. It only fails the step when an instruction file is loaded.

Error-handling findings in the core:

7. **The status-to-outcome mapping is copied in three places** (`src/stages/think.ts:85-86`, `src/stages/build.ts:235-236`, `src/stages/build.ts:406-407`). The rules are the same each time: `config-error` becomes `park`, `rate-limited` becomes `fail` with category `rate-limit`, and everything else (`timeout`, `over-budget`, `refused`, `bad-output`, `error`) becomes `fail` with category `other`.
8. **Provider outages are handled only on the API path.** In `AnthropicProvider` and `OpenAIProvider`, 429, 5xx and Anthropic 529 already become `RateLimitedError`, so `ApiRunner` returns `rate-limited` and the core backs off. Network failures (connection reset, DNS, TLS) are not caught and become `error`, which burns a counted attempt. They get their own `network` class because the cause may be local, for example the factory's key proxy being down. On the agent path a 429 or 5xx from the API is not classified at all: only 400, 401, 403 and 404 are (`run-agent.mjs`), so everything else is `error`. There is no separate outage or network class today; outages and rate limits share `rate-limited` where they are handled.
9. **The agent runner drops vendor detail.** It only forwards `apiErrorStatus` for `config-error`.

Where the code differs from the intended design in `adapters.md` (the doc now records the same points):

10. **The core-owned loop lives inside `ApiRunner`.** The design says the core owns the timer, the cost counter, the re-ask (twice) and usage logging. `ApiRunner` implements all four itself (`api.ts:197-276`). The suite tests behavior, not location, so this is recorded as a finding. Moving the loop into the core is a separate decision (D8).
11. **A missing model credential is not a start-up error for OpenAI models.** `checkRoutes` only checks `ANTHROPIC_API_KEY`. A `gpt-*` step with no `OPENAI_API_KEY` is silently rerouted to Opus (`stages/routing.ts:44`). An `auth` error can therefore reach the runner for some models and never for others.
12. **Secrets are redacted, not blocked.** The design says a secret hit blocks the call. `context/secrets.ts` replaces matches with placeholders and `pack.ts` records a `redactions` count. This matters for error text (see section 6).
13. **`max_tokens` is not treated as its own outcome.** Both providers report it in `Turn.stop`, but `ApiRunner` only checks `refusal`. A truncated answer with no tool call is re-asked like a plain-text answer, and can end as `bad-output` although the real cause is the output cap. Anthropic calls set `max_tokens: 32000`; OpenAI calls set none. See the message and content model in `adapters.md`.
14. **Images and reasoning content are not part of the runner contract.** `ContextPack.images` is never read by a runner. Anthropic thinking blocks are passed back unchanged; the OpenAI path only keeps the raw message. Neither is asserted anywhere.

Consequences of 7 to 9:

- A cost-cap hit is retried up the ladder like a flaky test. A stronger model on an `over-budget` result makes it worse.
- A `refused` result is retried the same way, although the same model will likely refuse again.
- The ladder behaves differently per runner for the same real-world event.
- Vendor-specific detail (HTTP status, SDK error class, stderr) is flattened into a string.

---

## 3. Design

### 3.1 Conformance suite

- One `runConformance(name, harness)` function. A harness builds a runner whose fake backend can play each scenario.
- Harnesses reuse the fakes already in the repo: a scripted `Provider` for `api`, a `FakeRt` container runtime for `claude-agent`. No network and no API cost.
- Adding a runner means one harness and one `runConformance` call.
- Location: `src/runners/conformance.test.ts` for now. Test files are excluded from `tsc` (see `tsconfig.json`), so the suite does not leak into `dist`. If other files need to import it, move it to a file added to the tsconfig exclude list.

### 3.2 Error taxonomy

**Principle (from `adapters.md`: "each adapter only translates, it holds no rules of its own"):**
- Adapters translate. Each one converts a vendor failure into one factory `errorClass` and keeps the raw detail. Nothing more.
- The core decides. What to do about an `errorClass` (retry, back off, park) is policy and lives only in the core, in one table.

`ResultStatus` stays as the coarse outcome label for backward compatibility. Two fields are added on failure results, both filled in by the adapter:

- `errorClass`: what kind of failure it is (the source of truth).
- `vendor: { code, http?, message }`: the raw vendor detail. Audit-only and never used for decisions.

| errorClass | Meaning |
|---|---|
| `auth` | Bad or missing key, 401/403 |
| `model-unavailable` | Unknown model, 404 |
| `bad-request` | 400, invalid params |
| `rate-limit` | 429, provider quota |
| `provider-outage` | The provider answered with a server error: 5xx, overloaded (Anthropic 529) |
| `network` | No answer at all: connection refused or reset, DNS failure, TLS failure, connect timeout. Can be local (no internet, VPN, or the factory's key proxy down) |
| `timeout` | Wall-clock limit |
| `budget` | Cost cap hit |
| `turn-limit` | `maxTurns` exhausted |
| `output-truncated` | The model hit its output cap (`max_tokens`, `finish_reason: length`) before giving a valid answer |
| `refusal` | Model declined, or the provider's content filter stopped the answer |
| `bad-output` | Schema failed after re-asks |
| `sandbox` | Instruction file loaded, container failed, missing result |
| `internal` | Adapter bug, unclassified |

### 3.3 Core policy table (lives in the core, not in adapters)

Proposed mapping. Rows marked **(new)** go beyond what `adapters.md` says and need a team decision (see D5 to D7, D9 and D10).

| errorClass | Core action | Notes |
|---|---|---|
| `auth`, `model-unavailable`, `bad-request` | park | Same as today's `config-error`. |
| `rate-limit`, `provider-outage`, `network` | `fail: rate-limit`, back off, uncounted | Today only the API path does this (429, 5xx and 529 are already `rate-limited`). **(new)**: network failures and agent-path 5xx, which are `error` today, would join it. `network` also carries a different park message (check connectivity or run `factory doctor`), see D10. |
| `timeout`, `turn-limit`, `bad-output` | `fail: other`, climb the ladder | Matches the doc's "twice, stronger model, other vendor, human". |
| `output-truncated` | `fail: other`, climb the ladder | **(new)** See D9. No same-call retry: the same prompt will likely truncate again. |
| `budget` | park for a human | **(new)** Today it is retried up the ladder. |
| `refusal` | one same-model retry, then other vendor | **(new)** Today it is retried like any other failure. |
| `sandbox` | `fail: safety` | Retry once, then park, per the existing ladder. |
| `internal` | park, raw detail kept | |

### 3.4 Stop-reason mapping (adapter side)

Each adapter maps the vendor's stop signal to an `errorClass` (or to success). This is translation only, so it belongs in the adapter. The "Today" column is the current behavior in the code; "Target" is the proposed mapping. Unknown values default to `internal` with the raw value kept in `vendor`, so nothing is guessed.

| Runner and signal | Today | Target |
|---|---|---|
| Anthropic `tool_use`, or any stop with tool calls | Calls served, loop continues | unchanged |
| Anthropic `end_turn`, `stop_sequence`, no tool calls | Re-ask, then `bad-output` | unchanged (`bad-output` after 2 re-asks) |
| Anthropic `max_tokens` | Re-ask path, may end as `bad-output` | `output-truncated` |
| Anthropic `refusal` | `refused` | `refusal` |
| Anthropic other values (for example `pause_turn`) | Treated as `tool_use` or `end` | `internal`, raw value in `vendor`. VERIFY which values the SDK can return. |
| OpenAI `stop` with no tool calls | Re-ask, then `bad-output` | unchanged |
| OpenAI `tool_calls` | Calls served | unchanged |
| OpenAI `length` | Re-ask path | `output-truncated` |
| OpenAI `message.refusal` | `refused` | `refusal` |
| OpenAI `content_filter` | Treated as a normal end | `refusal`. VERIFY the finish reason value against the current API. |
| Claude agent `success` | `ok` after zod | unchanged |
| Claude agent `error_max_turns` | `timeout` | `turn-limit` |
| Claude agent `error_max_budget_usd` | `over-budget` | `budget` |
| Claude agent `error_max_structured_output_retries` | `bad-output` | unchanged |
| Claude agent API error 400 | `config-error` | `bad-request` |
| Claude agent API error 401 or 403 | `config-error` | `auth` |
| Claude agent API error 404 | `config-error` | `model-unavailable` |
| Claude agent API error 429 | `error` | `rate-limit` |
| Claude agent API error 5xx | `error` | `provider-outage` |
| Anthropic or OpenAI call fails with no HTTP answer (reset, DNS, TLS, connect timeout), after the SDK's 2 retries | `error` (uncaught) | `network` |
| Claude agent cannot reach the key proxy or the API (no API error status) | `error` | `network` |
| Claude agent crash or missing result | `error` | `sandbox` |
| Claude agent refusal or truncation | Not reported | VERIFY whether the SDK exposes them; until then the agent cannot emit `refusal` or `output-truncated`. |

For the API runners, a provider stop reason and an HTTP error are different sources: HTTP errors before a turn exists map as in the taxonomy (429 and 5xx to `rate-limit` or `provider-outage`, 400 to 404 as above). Network failures are not caught today and would map to `network` (finding 8).

### 3.5 Shared code

- `src/runners/errors.ts`: the `errorClass` type and a `classifyHttp(status, body)` helper that adapters call. No policy in this file.
- Each adapter has a small `classify(vendorError)` that returns an `errorClass`. Codex and jcode implement the same function.
- `toStepOutcome(result)` in the core holds the policy table above and replaces the three copies. Callers stop mapping statuses themselves.

---

## 4. Decisions needed from the team

| # | Question | Recommendation |
|---|---|---|
| D1 | What does hitting `maxTurns` return? | Its own class, `turn-limit`. Resolves the `bad-output` vs `timeout` split. |
| D2 | Is usage reported on failed runs? | Yes, on every failure path. Cost caps and the ledger depend on it. |
| D3 | Do missing preconditions throw or return `error`? | Throw for programmer mistakes (missing `workdir`, missing tools). Document it in the contract. |
| D4 | Where does the suite live? | `conformance.test.ts` for now. |
| D5 | What does `budget` do? **(beyond `adapters.md`)** | Park for a human. Fits the "hard cap, stop cleanly" line in the doc's FAQ, but the doc does not specify it. |
| D6 | What does `refusal` do? **(beyond `adapters.md`)** | One same-model retry with the failure text, then other vendor. |
| D7 | Do `provider-outage`, `network` and `rate-limit` share one backoff budget? **(beyond `adapters.md`)** | Yes, the ladder's existing 15 minutes. |
| D8 | Is the core-owned loop (timer, cost counter, re-ask, usage logging) moved out of `ApiRunner`? | Not in this work. Record it as finding 10 and decide separately. |
| D9 | What does `output-truncated` do, and does every API call get an explicit output cap? **(beyond `adapters.md`)** | Do not retry the same call. Climb the ladder (raise effort, stronger model, other vendor). Set an explicit cap on OpenAI calls too, so the outcome does not depend on the server's default. Map `content_filter` to `refusal`. |
| D10 | What does `network` do? **(beyond `adapters.md`)** | Same uncounted backoff as `rate-limit` and `provider-outage`, sharing the 15-minute budget (D7). When the budget is spent, park with a message that points to local causes (connectivity, VPN, key proxy) instead of blaming the provider. |

---

## 5. Phases

1. **Taxonomy module, no behavior change.** Add `errors.ts` with the `errorClass` type and `classifyHttp`. Unit-test the classifier against a table of HTTP codes, SDK error shapes and agent exit states.
2. **Conformance suite.** Scenarios below, including the doc's five. Scenarios that current runners fail are marked `it.fails` with a finding number, so the suite is green and the gaps are visible.
3. **Migrate the adapters** in a separate PR. `ApiRunner`, `AnthropicProvider` and `OpenAIProvider` return `errorClass` and `vendor`. `ClaudeAgentRunner` maps agent statuses and `apiErrorStatus` through the same classifier and surfaces `deniedEdits`. Flip the marked tests to normal ones.
4. **Add the core policy table.** Replace the three ad hoc mappings with `toStepOutcome(result)` in `think.ts` and `build.ts`. Extend the ladder where D5 to D7, D9 and D10 change behavior.
5. **Keep `adapters.md` in step.** The update that matches the doc to the code is drafted (section 9). Once D1 to D10 are decided, add the error taxonomy section and flip the *planned* markers to *built* as each phase lands. Do this before writing Codex.
6. **New runners** (`codex`, `jcode`) ship with a `classify` function and must pass the suite before they merge.

### Conformance scenarios

The first five rows are the five conformance jobs from `adapters.md`. The rest add the error taxonomy. Each row asserts `errorClass`; the core's reaction is tested separately against the policy table.

| Scenario | Expected result | Runners |
|---|---|---|
| Valid JSON | `ok`, output matches the zod schema | all |
| Respect the folder | The agent can only touch the run worktree; mounts and masks match the expected set | agents |
| Respect the timeout | `timeout`; never `ok` | all |
| Report usage | Tokens, turns and `estUsd` filled in, on success and on every failure path | all |
| Refuse a protected-file edit | A denied edit is reported (`deniedEdits`) and the step does not silently succeed | agents |
| Schema fails after re-asks | `bad-output` | all |
| 401/403 | `auth` | all |
| 404 unknown model | `model-unavailable` | all |
| 429 | `rate-limit` | all |
| 5xx or overloaded | `provider-outage` | all |
| Connection reset, DNS or connect failure | `network`, raw cause in `vendor` | all |
| Cost cap | `budget`; never `ok` | all |
| Turn cap | `turn-limit` | all |
| Refusal | `refusal` | api (agents once the SDK reports it) |
| Content filter stop | `refusal` | api (OpenAI-style) |
| Output truncated (`max_tokens`, `length`) with no answer | `output-truncated`; never `ok`, not reported as a missing answer | api |
| Unknown stop reason | `internal`, raw value in `vendor` | api |
| Plain-text answer instead of `submit_result` | re-asked at most twice, then `bad-output` | api |
| Unparsable tool arguments | schema failure and a re-ask, not a crash | api |
| Unavailable tool requested | error tool result, step continues | api |
| Instruction file loaded, missing result | `sandbox` | agents |
| Unclassifiable throw | `internal`, raw detail preserved | all |
| Every failure path | `vendor.message` non-empty | all |

---

## 6. Pain points and mitigations

- **Flaky timing tests.** The timeout scenario must not sleep. Drive `ApiRunner` with a limit already in the past and `FakeRt.wait` returning `undefined`.
- **Environment leaks.** The agent tests set `FACTORY_HOME` and `ANTHROPIC_API_KEY`. The harness must set and restore both, and assert the key never appears in the container spec.
- **False confidence.** A fake that always succeeds proves nothing. Each scenario needs a negative control showing it fails when the fake misbehaves.
- **Vendor drift.** SDKs change error shapes. Classifiers default to `internal` rather than guess, and the raw error is always kept in `vendor`.
- **Secrets in error text.** Vendor messages can echo keys or prompts. `vendor.message` must go through the same `Redactor` (`src/context/secrets.ts`) as context packs before it reaches the ledger or trace. Redaction replaces matches with placeholders; it does not block (finding 12), so the test must assert the placeholder appears, not that the call is refused.
- **Ladder regressions.** Changing how `budget` and `refusal` route alters retry behavior. Phase 4 needs ladder tests showing the old and new decision for each class.
- **Ledger compatibility.** Existing ledgers store `failure` records such as `agent-${status}`. New `errorClass` values must not break `factory verify-evidence` on old runs, so the reader tolerates both.
- **Agent-side gaps.** The in-container `docker/agent/run-agent.mjs` must report enough for the host to classify: `apiErrorStatus`, a distinct refusal state, turn-limit vs timeout. That change needs an agent image rebuild.
- **Too many classes.** Fourteen is the ceiling. Each class must change what the core does. Merge any two that always route the same way.
- **Scope creep.** No changes to `api.ts` or `claude-agent.ts` in phase 2. Findings go in the PR description, not silent fixes.
- **Worktree setup.** A fresh worktree has no `node_modules`. Run `npm ci` (or link the main checkout's copy) before `npm test`.

---

## 7. Done means

- `npm run typecheck` and `npm test` pass.
- The three duplicated mappings are gone, replaced by one function with its own tests.
- Adapters hold no policy: `errors.ts` and each `classify` only translate, and the policy table lives in the core.
- Every `errorClass` has at least one conformance scenario, and the doc's five jobs are all covered. Every adapter passes them or carries a numbered `it.fails`.
- Ladder tests cover the routing of each class.
- `adapters.md` has an error taxonomy section, and its built and planned markers match the code.
- Adding a runner is one harness, one `classify` function and one `runConformance` call.

## 8. Alignment with `adapters.md`

| `adapters.md` says | This plan |
|---|---|
| One small `Runner` interface, vendor-neutral. | Kept. `errorClass` and `vendor` are added to `Result`. |
| "Each adapter only translates. It holds no rules of its own." | Adapters emit `errorClass` only. The policy table is in the core (section 3.3). |
| The conformance test has five jobs: valid JSON, respect the folder, respect the timeout, report usage, refuse a protected-file edit. | All five are in the suite (section 5). Error-class scenarios are added on top. |
| The core owns the timer, cost counter, re-ask (twice) and usage logging. | The doc now says these are built inside the runners today and the move to the core is planned. This plan agrees: finding 10 and D8. |
| Escalation is "twice, stronger model, other vendor, human". | Kept. `budget`, `refusal`, `provider-outage` and `output-truncated` and `network` handling are new proposals (D5 to D7, D9, D10). The other-vendor rung needs the Codex runner. |
| Start-up checks: step kind vs runner kind (built), rejecting unbuilt runners (built), a credential per model (Claude only). | The suite tests runner behavior, not `checkRoutes`. Finding 11 records the OpenAI gap. If that check is extended later, it should reuse the `auth` and `model-unavailable` definitions so the two never disagree. |
| A secret hit in the context pack is redacted with a placeholder (built); blocking is not implemented. | Section 6 tests redaction of `vendor.message`, not blocking (finding 12). |
| Only the Anthropic and OpenAI-compatible providers exist; Bedrock and Vertex are planned. | `classifyHttp` covers those two error shapes. New provider shapes are added with the provider. |
| `CodexRunner` has a core timer only, no native cap (planned). | Supports the split: the core must enforce limits and adapters only report them. |

## 9. Status of the `adapters.md` update

A draft update is done in the working tree (uncommitted). It changes:

- `Job` and `Result` now match `src/runners/types.ts`: `pack` and a zod schema, eight statuses, `estUsd` and the extra usage fields.
- Runners, config, start-up checks, the core-around-runner list and the per-runner table are marked *built* or *planned*. Examples: no `credentials:` block, no model lists, no `PostToolUse` lint hook, redaction instead of blocking, no Bedrock or Vertex.
- The conformance test is described as planned, with a pointer to this plan.

Still to do (phase 5): add an error taxonomy section (`errorClass`, `vendor`, the core policy table) after the team decides D1 to D10, and update the markers as each phase lands.

## 10. Open risks

- Two harnesses may not prove the contract is vendor-neutral. Codex is the real test.
- The fakes mirror current behavior, so they can hide real-SDK differences. A small opt-in live smoke test is a possible follow-up, and it costs money.
