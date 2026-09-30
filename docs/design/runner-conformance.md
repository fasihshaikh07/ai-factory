# Proposal: Shared Error Classes and a Runner Conformance Suite (2026-09-30)

Status: proposal for after Thursday's demo. No code yet. Checked against main at 511d41b.

## Summary

Every runner should behave the same through the `Runner` interface, so that adding Codex or jcode is one adapter plus one suite to pass. Two things are missing:

1. **Shared error classes.** Each runner reports failures as coarse statuses, and the two runners map the same event differently. Each adapter should translate vendor failures into one shared set of classes, and the core should decide what to do about each class in one place.
2. **One conformance suite.** Each runner has its own tests with its own fakes. Nothing checks that runners behave alike, so a new runner has no gate.

Most single-runner behavior is already tested and stays where it is:
- `api.test.ts`: valid answers, re-asks, read tools, the turn, cost, refusal and rate-limit stops, the plain-text nudge, effort, the last-turn warning.
- `agent.test.ts`: a missing result, a loaded instruction file.

This proposal adds only the shared classes and the shared suite.

Size: about 900 to 1,400 lines over four PRs. Tests come first in each.

## What's wrong today

**The runners disagree on the same event.**
- Turn limit: the API runner returns `bad-output` ("No result after N turns"); the agent runner returns `timeout`.
- HTTP 429 or 5xx: `rate-limited` on the API path, so the core waits without counting an attempt. On the agent path it's plain `error`, which uses up a counted attempt.
- Network failures (connection reset, DNS, TLS) are uncaught on both paths and become `error`. The cause may be local, for example the key proxy being down.

**Some failures have no name.**
- An answer cut off at the output cap has no status. The API runner re-asks it like a missing answer (the trace does flag "hit max tokens").
- A refusal and a cost-limit hit are retried up the ladder like a flaky test. A stronger model makes a cost-limit hit worse.

**The same policy is copied three times.** The step code maps a runner status to an outcome in `think()` (`src/stages/think.ts`) and twice in `src/stages/build.ts` (author-tests and implement). Every copy has the same rules: `config-error` parks, `rate-limited` backs off, everything else climbs the ladder.

**Vendor detail is lost.** HTTP status, SDK error type and message are flattened into one string. The agent runner keeps the HTTP status only for `config-error`.

## Shared error classes

Adapters translate; the core decides.
- Each adapter turns a vendor failure into one error class and keeps the raw detail (code, HTTP status, message) for the record.
- The raw detail is never used for decisions.
- `Result.status` stays, so existing ledgers and failure signatures keep working. `errorClass` and `vendor` are added to failed results.

| Class | Meaning |
|---|---|
| `auth` | Bad or missing key (401, 403) |
| `model-unavailable` | Unknown model (404) |
| `bad-request` | Invalid request (400) |
| `rate-limit` | 429 or quota |
| `provider-outage` | 5xx, or Anthropic 529 |
| `network` | No answer at all: connection reset or refused, DNS, TLS, connect timeout |
| `timeout` | Wall-clock limit |
| `budget` | Cost limit |
| `turn-limit` | Turn limit used up |
| `output-truncated` | Output cap hit before a valid answer |
| `refusal` | The model declined, or a content filter stopped it |
| `bad-output` | Schema still failing after re-asks |
| `sandbox` | Instruction file loaded, container failure, missing result |
| `internal` | Unclassified; raw detail kept |

Each class must change what the core does. Any two that always get the same treatment should be merged.

### What each vendor signal becomes

| Signal | Today | Class |
|---|---|---|
| Anthropic `max_tokens` stop; OpenAI `incomplete_details.reason: "max_output_tokens"`; local `finish_reason: length` | re-asked, may end as `bad-output` | `output-truncated` |
| Anthropic `refusal` stop; OpenAI refusal content items; local `message.refusal` | `refused` | `refusal` |
| API runner turn limit | `bad-output` | `turn-limit` |
| Agent `error_max_turns` | `timeout` | `turn-limit` |
| Agent `error_max_budget_usd`; API runner cost limit | `over-budget` | `budget` |
| HTTP 401, 403 | `config-error` | `auth` |
| HTTP 404 | `config-error` | `model-unavailable` |
| HTTP 400 | `config-error` | `bad-request` |
| HTTP 429 | `rate-limited` (API), `error` (agent) | `rate-limit` |
| HTTP 5xx, Anthropic 529 | `rate-limited` (API), `error` (agent) | `provider-outage` |
| No HTTP answer | `error` | `network` |
| Agent crash, missing result, loaded instruction file | `error` | `sandbox` |
| Anything unrecognised | `error` | `internal`, raw value kept |

Anthropic 429, 5xx and network failures reach the runner only after the Anthropic client's 2 retries. OpenAI's client doesn't retry.

## What the core does with each class

One function, `toStepOutcome(result)`, replaces the three copies.

| Class | Core action |
|---|---|
| `auth`, `model-unavailable`, `bad-request` | Park at once (same as `config-error` today). |
| `rate-limit`, `provider-outage`, `network` | Wait and retry without counting an attempt, sharing today's 15-minute budget. When it runs out, park. For `network`, the message points at local causes (connection, VPN, key proxy) instead of the vendor. |
| `timeout`, `turn-limit`, `bad-output` | Climb the ladder, as today. |
| `output-truncated` | Climb the ladder (raise effort, stronger model). Don't repeat the same call: the same prompt will likely be cut off again. |
| `budget` | If the step's limit was cut to what's left of the run's limit (`stepBudgetUsd`), the run is out of money: park with the cost card. If the step hit its own limit with money left, climb the ladder. |
| `refusal` | One retry with the refusal noted. If it refuses again, park and let the user decide. Never switch vendor on its own. |
| `sandbox` | Treat as a safety failure: retry once, then park. |
| `internal` | Park, raw detail kept. |

**Decisions for the team:**
- whether a `budget` hit with money left should climb the ladder or park;
- whether `network` shares the 15-minute budget with rate limits;
- whether OpenAI calls get an explicit output cap, so truncation doesn't depend on the server's default.

## The conformance suite

- One function, `runConformance(name, harness)`. A harness builds a runner whose fake backend plays each scenario.
- It reuses the fakes the repo already has: the scripted `Provider` for the API runner, the fake container runtime for the agent runner, and the local fake HTTP server from `openai.test.ts` for the OpenAI request shape.
- Adding a runner means one harness and one `runConformance` call.

Scenarios. Each checks `errorClass`; the core's reaction is tested separately against the table above.

| Scenario | Expected | Runners |
|---|---|---|
| Valid answer | `ok`, output matches the schema | all |
| Time limit | `timeout`, never `ok` | all |
| Usage | all usage fields filled, on success and on every failure | all |
| Protected-file edit | the denied edit is reported, and the step does not succeed silently | agents |
| 401 / 404 / 400 | `auth` / `model-unavailable` / `bad-request` | all |
| 429 | `rate-limit` | all |
| 5xx | `provider-outage` | all |
| Connection reset or DNS failure | `network`, raw cause kept | all |
| Cost limit | `budget` | all |
| Turn limit | `turn-limit` | all |
| Refusal | `refusal` | API (agents once the SDK reports it) |
| Output cap hit with no answer | `output-truncated`, never reported as a missing answer | API |
| Unknown stop signal or unclassifiable error | `internal`, raw detail kept | all |
| Any failure | `vendor.message` non-empty and redacted | all |

The agent runner fails some of these today: usage on timeout, 429 and 5xx, and denied edits. Those are marked as expected failures, so the suite is green and the gaps stay visible. They flip to normal tests when the adapter is fixed.

## Plan (tests first)

1. **Tests.** Write the classifier tests (a table of HTTP codes, SDK error shapes, stop signals and agent exit states) and the conformance suite, with today's gaps marked as expected failures. No production code changes.
2. **Classifier and adapters.** Add `src/runners/errors.ts` (the class type and an HTTP classifier, no policy) and a small `classify` in each adapter. They fill in `errorClass` and `vendor`. Behavior is unchanged. The agent entrypoint (`docker/agent/run-agent.mjs`) reports the API status for every error, which needs an agent image rebuild. Expected failures flip to passing.
3. **Core policy.** Replace the three copies with `toStepOutcome`, with ladder tests showing the old and new decision for each class. Behavior changes land here, after the team decisions above.
4. **New runners.** Codex and jcode ship with a `classify` and must pass the suite before they merge.

## Risks

- **Timing tests.** Tests must not sleep. Use a time limit already in the past, and a fake runtime that returns at once.
- **Environment leaks.** Set and restore `FACTORY_HOME` and API keys in each test, and check a key never appears in a container spec or a trace.
- **Fakes that always pass.** Give each scenario a variant that must fail.
- **Vendor drift.** SDKs change their error shapes. Classifiers return `internal` rather than guess, and always keep the raw error.
- **Secrets in error text.** Vendor messages can echo keys or prompts. Pass `vendor.message` through the same redactor as context packs.
- **Old ledgers.** Old runs store failures like `agent-error`. `factory verify-evidence` must still read them.
- **Two runners may not prove neutrality.** Codex is the real test.
