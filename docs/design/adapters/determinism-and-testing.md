# Adapter layer: Determinism, replay and testing

Part of [adapters.md](../adapters.md), which holds the glossary, interface and section map. Section numbers are unchanged, so a `§N` reference anywhere in the docs resolves through that map. Status legend and gap IDs (`CACHE-1` etc.) are defined there and in [decisions-and-gaps.md](decisions-and-gaps.md).

## 22. Determinism and replay

The factory makes its **decisions** reproducible and checkable. It does not make **model output** reproducible. These are different guarantees, and only the first is built.

**What is deterministic and verifiable (built)**

| Area | How |
|---|---|
| Gates | Each gate result records its inputs and the hash of the policy used. `factory verify-evidence` re-hashes the ledger and re-runs every gate predicate, and flags a gate whose decision differs from the recorded one. It does not re-run tests or scans; those are recorded evidence. |
| Ledger | The event log is append-only and synced after each write. Artifacts are stored under their SHA-256 and re-hashed on read; a mismatch raises a corruption error. A stale executor is fenced out by an epoch check. |
| Run state | State is a pure function of the ledger events, so the next step is reproducible from the events alone. |
| Resume | A completed step is skipped only when its `inputsHash` is unchanged. The hash covers the input artifact hashes, the step definition, the prompt template version, the model, and the start commit for coding steps. |
| Prompts | Every pack is stored by hash. Its manifest records the stage, model, recipe version, sections, redaction count and pack hash. |
| Model turns | Each turn is stored as a blob and referenced from the trace, with model, usage and cost. |

**What is not reproducible (not built)**

- **Model output.** Temperature, seed and top_p are never set (see "Parameter mapping"), so the same pack can produce different answers. A rerun is not expected to match.
- **Model version.** The model id is hashed as a string. A vendor alias can move to new weights without the id changing, and the exact version reported by a response is not recorded (VERIFY what each response returns).
- **Replay.** Stored turns are for audit only. Nothing feeds them back through a runner, so a run cannot be re-executed without calling the vendor again.
- **What the resume hash leaves out.** Effort, the output cap and other adapter settings are not in `inputsHash`. Versions are recorded in `run.created` but not hashed, so upgrading the factory, an SDK or the price table does not invalidate a completed step. Changing effort can silently reuse an old result.
- **Agent runs.** Results depend on the coding engine, the worktree and the container image. The agent image is rebuilt when its inputs change, but its digest is not tied to the step's hash.
- **Environment.** The .NET SDK image, package feeds and the test database are external inputs. Each verify run records the SDK image digest and the database image digest (`toolVersions`, built). The start commit is hashed. Neither digest is part of a step's `inputsHash`, and the package versions actually restored from the feeds are not recorded (VERIFY).
- **Non-answer differences.** Prompt cache hits and hidden SDK retries change cost and latency but are not recorded, so two runs can differ with no explanation on record.

**The goal, stated plainly.** Auditability plus bounded drift, not identical output. With free-running models and no seed, identical reruns are not achievable, and the factory should not claim them. The guarantee is that every decision can be re-checked from recorded evidence, that tampering is detectable, and that a change to what a step consumed is visible in its hash.

**Proposed handling (planned, not built)**
1. `DET-1` **Record what ran.** With each turn, store the exact model version the response reports, the effort, the output cap and any parameter the adapter changed or dropped.
2. `DET-2` **Widen the resume hash where reuse would be wrong.** Include effort and the adapter parameters that change output. Record factory, SDK and price-table versions in the turn record, and decide separately whether a version change should invalidate a step.
3. `DET-3` **Record and replay at the provider seam.** A replay provider reads stored turns and returns them through the same `Provider` interface that the tests already script. Steps then rerun deterministically with no vendor call, no cost and no network. Replay is refused when the pack hash differs from the recorded one.
4. `DET-4` **Optional sampling control.** Do not add temperature or seed to `Job`. If a step needs it, add one neutral knob and map it per adapter (see "Parameter mapping"). Vendors that offer a seed give best-effort determinism only.
5. `DET-5` **Tie agent runs to their environment.** Record the agent image digest and the SDK image used with each attempt.
6. `DET-6` **Conformance scenarios.** The same scripted turns produce the same result and the same ledger events. Replaying a recorded run produces the same decisions. A changed pack hash makes replay fail with a clear message.
7. `DET-7` **Pin the build environment.** Add the SDK image digest and the database image digest already recorded by verify runs to the resume hash of the steps that run builds or tests. Record a hash of the restored package set (for example the lock file, or the list of restored packages) with each verify run, so a feed change is visible.
8. `DET-8` **Record cost-side differences.** Store cache read and write tokens and the retry count with each turn record (the token counts already reach the ledger; the retry count depends on "Retries"), so two runs that differ in cost or latency can be explained from the record.

**Every gap has a resolution**

| Gap | Resolution | Enforcement | Residual risk |
|---|---|---|---|
| Model output varies | Not made identical. Bounded by recording every turn (`DET-1`) and replaying at the provider seam (`DET-3`). An optional neutral sampling knob per step (`DET-4`). | Replay refuses a changed pack hash. | Live reruns still differ. Vendor seeds are best-effort. |
| Model version unknown | Record the version each response reports (`DET-1`). | A turn record without a version is a conformance failure once the response carries one. | Vendors may report only an alias (VERIFY). |
| No replay | Replay provider (`DET-3`). | Conformance scenario (`DET-6`). | Agent internals cannot be replayed. |
| Resume hash too narrow | Add effort and adapter parameters that change output (`DET-2`). Record versions in the turn record. | Test: a changed effort re-runs the step. | Deciding which version changes should invalidate a step is a team decision. |
| Agent runs untied | Record agent and SDK image digests per attempt (`DET-5`). | Step record fails to complete without them. | The engine's own updates inside an image are covered only by the digest. |
| Environment not in the hash | Pin the build environment (`DET-7`). | Test: a changed image digest re-runs build and test steps. | External feeds can serve different packages under the same version; a recorded package set makes this visible, not impossible. |
| Cache and retries not recorded | Record them per turn (`DET-8`). | Test: the turn record contains both. | None for correctness; this is for explanation only. |

`DET-2`, `DET-5`, `DET-7` and the version check in `DET-1` turn a silent difference into a visible one. `DET-3` and `DET-6` make decisions replayable. Nothing here promises identical model output.

**Limits of this design**
- Replay reproduces the factory's behavior given recorded model output. It says nothing about what a live model would say today.
- Recording full turns stores prompts and answers. They are redacted like packs, but the ledger then holds more sensitive text, so its permissions and retention matter.
- Agent replay is limited: the engine runs inside the container, so only its final result and progress feed can be recorded, not each internal turn.

---

## 26. Testing

Tests cover the runner loop and the safety rules well, using fakes. They cover almost nothing that depends on a real vendor, a real SDK or a real container. This section records what exists, what is missing, and the layers proposed to close the gap.

**What exists (built)**

| Test | What it covers | Backend |
|---|---|---|
| `runners/api.test.ts` (7 tests) | Valid `submit_result`; two re-asks then `bad-output`; read tools served and unavailable tools refused; turn cap, cost cap, refusal and rate limit; plain-text nudge; prices and model families; which models accept effort | Scripted `Provider` |
| `runners/agent.test.ts` (6 tests) | Masks over git metadata, agent files and secret files; the key proxy is used and the real key never appears in the container spec; an instruction file fails the step; a missing result is an error; the egress proxy allow-list | `FakeRt` container runtime |
| `credit-safety.test.ts` (9 tests) | Key proxy restart when keys change; agent image fingerprint; provider config errors become `config-error`; plain-words error texts; `--max-cost` only lowers the limit; the retry budget; `factory smoke` refuses without a key and stops at the first failing model | Fakes, plus the smoke runner with stubs |
| `stages/e2e.test.ts` (4 tests) | The brownfield slice through the real core: approval, delivery, resume after a crash, park on a safety gate, revision after a rejection | Scripted model and fake containers |
| `factory smoke` | Real calls: the key, each model, the key proxy and a tiny agent job | Live vendors and Docker. A command run by hand, not part of `npm test`. |

**What is missing**

| Gap | Why it matters |
|---|---|
| No shared contract test | Nothing checks that the two runners behave alike. The conformance suite is planned (`TEST-1`). |
| The real providers are untested | `AnthropicProvider` and `OpenAIProvider` (request bodies, stop-reason mapping, tool-result format, error mapping) are replaced by fakes in every test. A wrong request or mapping only appears on a live call. |
| Failure classes | Config errors are tested. 5xx, network failures, 429 with backoff and the agent's error statuses are not. |
| Timeouts and cancellation | No test of the deadline, a hung call, the container timeout or an abort. |
| Usage and cost | Price math and the cost-cap stop are tested. Agent usage on failure paths, the fallback price for unknown models and ledger totals versus runner usage are not. |
| Caching, retries, parameter mapping | No test that cache markers are sent, that SDK retries happen, or that each effort level maps as documented. |
| Stop reasons and content | `max_tokens`, unknown stop reasons, images, and unparsable OpenAI tool arguments are untested. |
| The agent hook | The `PreToolUse` hook in `docker/agent/run-agent.mjs` (protected paths, file scope, Bash blocks) has no test of its own. The tests fake the whole container. |
| Live drift | No live test is gated behind an environment variable. Fakes encode current behavior, so a vendor change cannot fail a test. |
| Coverage | The test config has no coverage setup, so there is no coverage figure. |
| Determinism | No test that the same scripted turns give the same ledger events, and no replay test. |

**Proposed layers (planned, not built)**

| Layer | Purpose | Backend | Runs |
|---|---|---|---|
| `TEST-1` Conformance suite | The same scenarios against every runner: valid output, timeout, usage, error classes, stop reasons, refusal, protected edits | Harness fakes | Every `npm test` |
| `TEST-2` Provider request and response tests | Check the exact request each provider builds (system, tools, effort, output cap, cache markers) and how it maps responses, stop reasons and HTTP errors | The SDK client with a stubbed HTTP layer, no network | Every `npm test` |
| `TEST-3` Agent hook tests | Run the hook logic in isolation with sample tool inputs: protected path, out-of-scope path, edit outside the workspace, blocked Bash commands, and a Bash write that the hook does not catch | The hook function loaded directly | Every `npm test` |
| `TEST-4` Replay tests | Feed recorded turns through the provider seam and assert the same decisions and ledger events | Recorded turns (see "Determinism and replay") | Every `npm test` once replay exists |
| `TEST-5` Live suite | A few small real calls per vendor for the failure classes that fakes cannot prove: a bad key, an unknown model, a tiny valid answer, a cache read on a repeated prefix | Real vendors | Gated by an environment variable; costs a few cents; run before releases and after SDK upgrades |
| `TEST-6` Registry checks | Every model in the default routes has a complete registry entry, and each start-up check has a failing and a passing example | None | Every `npm test` once the registry exists |

Layers 1 to 4 and 6 are free and deterministic. Layer 5 is the only one that spends money and the only one that detects vendor drift.

**Rules for adapter tests**
- Each scenario has a negative control: a variation that must fail, so a fake that always succeeds cannot pass it.
- Tests set and restore process environment such as `FACTORY_HOME` and API keys, and assert that a key never appears in a container spec or a trace.
- Timing scenarios must not sleep. Use a deadline already in the past, or a fake runtime that returns immediately.
- A scenario that a runner cannot pass yet is marked as an expected failure with its gap-register ID, so the gap stays visible and the suite stays green.
- A new runner ships with its conformance harness, its provider or engine mapping tests, and a note in the live suite before it merges.

**Measuring the tests**
- Add a coverage setup so the runner and provider files have a number, and track it. Do not treat the number as a goal: the provider mapping code is what must be covered, not every line.
- Record which scenarios were run live and when, so a stale live result is visible.

**Limits of this design**
- Fakes prove the factory's logic given a described vendor behavior. They cannot prove the description is right. Only layer 5 does.
- A live suite depends on vendor uptime and quotas, so it must never gate every change.
- The agent's inner loop runs inside a vendor engine, so the factory can test only its result file, its progress feed and its hook, not each internal turn.
