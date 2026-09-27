# Gate Engine v2: Simple Design + Explainer (2026-09-26)

Purpose: make "nothing unverified ships" true in code, and make every run reviewable afterwards. v2 applies an independent fresh-context review (15 findings; see §6). Ahsan delegated ownership of this component to Claude (2026-09-26).

---

## Part 1. The idea in plain words

A **gate** is a checkpoint between two steps. A step produces something (a spec, a plan, tests, code). The gate looks at evidence about it and answers one question: *may the run move on?*

Five rules make gates trustworthy:
1. **Gates are plain code, never a model.** Models produce files; gates check them. The same inputs always give the same decision.
2. **Gates read evidence the factory produced itself, never claims.** "All tests pass" from the agent means nothing. The factory runs the tests itself, in its own sealed container, and the gate reads *that* result.
3. **Whoever produced the work never passes its gate.** The implementer's model isn't its reviewer. Human gates accept only a human.
4. **Everything is bound to fingerprints (hashes).** An approval is for *this exact* plan. A pass is for *this exact* code. If anything changes afterwards, the approval or pass no longer counts.
5. **Gates can't be skipped.** A few can be waived by a named human with a reason. The safety ones can't be waived at all.

**Analogy:** airport security. The traveller (agent) can say anything; the scanner (gate) looks only at the bag. The bag is sealed after the scan (hash). If it's reopened, it's scanned again.

---

## Part 2. The design

### 2.1 Two halves: producers and predicates
Every gate is split in two:
- **Producer** (does the work, not replayable): runs a tool in a **sealed container**, such as build, tests, lint, secret scan or dependency audit. It records the output **plus the tool version**, then saves the result into the ledger.
- **Predicate** (the decision, replayable): a pure function over ledger files. No model, no network, no clock.

```ts
interface GateDef {
  id: string;                       // "integrate.locked-tests-all-executed"
  after: StageName;
  reads: ArtifactKind[];            // ledger artifacts only
  predicate: (a: Artifacts, p: Policy) => GateResult;   // pure
  waiver: "none" | "human";         // safety gates: none
}
interface GateResult {
  gateId: string; passed: boolean; details: string;
  failures?: Failure[];
  inputsHash: Sha;                  // exactly what it read
  treeSha?: Sha;                    // code state it judged (code gates)
  waiver?: { human: string; reason: string; boundTo: Sha };
}
```
`factory verify-evidence` **re-checks decisions**: it re-hashes the ledger files and re-runs every predicate. It does **not** re-execute tests or scans. Those results are recorded evidence, stamped with tool versions.

### 2.2 Isolation: where things run (fixes the critical finding)

| What | Where | Can reach the ledger? |
|---|---|---|
| Coding agent | Sandbox container A: worktree mounted, no network (registry allowlist only) | **No** |
| Build, tests, scans (producers) | Throwaway container B: **copy** of the gated commit, fixed runner command from the stack pack, never a repo script as entry point | **No**; results captured from stdout/reporters by the core |
| Gate predicates, ledger, approvals | Core process on the host | Yes |

Repo code (MSBuild targets, npm scripts, source generators, product code) only ever runs inside a container with no ledger mount and no host access. So it can't rewrite results, touch the ledger or call `factory approve`.

### 2.3 Hash binding
- **Code:** before any gate runs, the core stops the agent's container (killing leftover processes), commits the worktree and records the **tree SHA**. Code gates judge that SHA. Deliver pushes that SHA plus **one manifest-only commit** on top; verify-evidence checks the PR head's parent equals the gated SHA and that the extra commit changes only `.factory/evidence-manifest.json` (run-manager §2.10).
- **Approvals:** the card shows the artifact hash. `factory approve <run> <hash-prefix>` fails if the ledger head has a different hash. Regenerated plan → new card. Old approvals can't be replayed.
- **Waivers and unlocks:** bound to the gate result's `inputsHash`.
- **Manifest:** at deliver, the core posts the manifest hash into the PR description and a forge commit status via its own forge adapter, and keeps it in the ledger. verify-evidence compares against *that*, not against the manifest in the branch, so editing the files and the hashes together is detected.

### 2.4 The lock set (what the agent may never change)
Locked by hash after author-tests:
- acceptance and characterization test files;
- **test project files** (`*.csproj` of test projects, `.sln` test entries, test sections of `package.json`);
- **runner config** (`.runsettings`, `xunit.runner.json`, jest/vitest config and setup files);
- shared test helpers and custom `WebApplicationFactory` classes;
- fakes (MSW/WireMock) and snapshot files.

Plus the **config-integrity set** (protected unless the plan declares them): lint, analyzer and TS configs, `Directory.Build.*`, `global.json`/`.nvmrc`, CI files, migrations, `.factory/`, `.gitattributes`, `.gitmodules`, and agent instruction files at any depth incl. new ones (`CLAUDE*.md`, `AGENTS*.md`, `GEMINI.md`, `.claude/`, `.codex/`, `.cursor/`, `.cursorrules`, `.windsurfrules`, `.mcp.json`, `.github/copilot-instructions.md`, `.github/instructions/`), and package-feed config (`nuget.config`, `.npmrc`, `.yarnrc*`, `Directory.Packages.props`).

The integrate gate also checks **every expected locked test ID actually executed and passed**. Removing a test from compilation, or filtering it out, fails even if "0 failures" is reported.

### 2.5 Where the gates sit

| After | Producer (sealed) | Predicates |
|---|---|---|
| discover | baseline build/test/lint/audit | baseline recorded, tool versions stamped |
| intake | – | schema; risk = max(rules, model) |
| ground | – | every anchor resolves |
| clarify | – | ≤5 questions; high-risk assumptions flagged |
| specify | – | 12 spec lint checks; stability; critic findings (blocking derived by code from severity); round trip clean |
| design (UI) | – | no unmapped REQs, no orphan screens |
| impact | – | risk ≤ policy or human; blast-radius flag |
| plan | – | REQs covered; ≥2 options + ADR; file scopes don't overlap; ≤15 rules/task; **any declared protected path forces risk ≥ medium** (a human sees it) |
| author-tests | **run new tests on base, twice** | each AC test fails on base (plus the plan's stub commit, context-builder §2.8) with an assertion or not-implemented failure, reproducibly; characterization passes on base; lock recorded |
| implement (per task) | build + unit + scoped tests; secret scan of the commit | diff within file scope; lock set and config set unchanged; no escape hatches, no new `skip/only`, no deleted tests; new lint findings = 0 vs baseline; no secrets |
| integrate | full build + suite; architecture, dependency (OSV + registry), a11y where UI | **no new failures vs baseline**; all expected locked + characterization IDs executed and passed; size/coverage limits |
| accept | boot app in E1, replay AC tests with recording | each AC has evidence of its kind: HTTP, **job run + outbound calls recorded by fakes**, DB rows, screenshot, manual |
| review | – | blocking derived by code from category + confidence ≥ threshold; reviewer family ≠ implementer family (or noted as single-family) |
| deliver | secret scan of **every commit** in the branch | manifest complete; pushed SHA = gated SHA; manifest hash posted |
| linked runs (G1) | – | the frontend run's contract hash = the backend's locked contract hash; a backend revise marks the frontend run stale |
| revise (G2) | – | PR comments and CI text treated as untrusted input; classified, then routed through the normal gates |

**Flakiness:** a failing **non-locked** test is re-run once in a fresh sealed container. A pass on re-run is marked **flaky** in the PR, never silent. Locked AC and characterization tests must pass first time; infra is classified only when a core probe also fails (verify-runner §2.6).

### 2.6 One failure ladder (replaces per-gate routing)
Checked in this order; the first match wins:
1. **Safety gate failed** (lock, secret, protected path, SHA mismatch) → the change is rejected; retry the step once with the failure; a second time → **park**.
2. **Locked test fails on 2 attempts** → test-defect check (A5). "Test wrong" → human unlock card. "Code wrong" → continue the ladder (counts toward 4).
3. **Rate limit / outage** → back off, max 15 min total, not counted; then park.
4. **Anything else** → retry with failures.json (fresh process) → higher effort → stronger model → other vendor (only if in `allowedAgents` and not `localOnly`) → **park**.

**Global stops:**
- the same failure signature twice, or no diff change between retries, skips to the next rung;
- 6 attempts per task, the run's cost cap, or the wall-clock cap → **park**.

**Partial delivery:** passing tasks can go in a **draft** PR, with the unmet ACs listed. You decide.

### 2.7 Human gates
- Types: onboarding card (once per repo), question card, approval card, merge, plus unlock requests (lock/protected path, from A5 or a declared plan) and waivers.
- Passed only via `factory approve | reject | waive | unlock <run> <hash-prefix>` on the host. The agent has no host access (§2.2), so it can't call it.
- The approver types the risk note. Reject requires a reason, which becomes a change input (G7).
- **Known limit (POC):** on a single dev machine, identity = the host OS user. Real identity comes later with SSO-signed approvals.

### 2.8 Waivers and unlocks
- **Waivable** (named human + reason, bound to the gate's input hash, listed in the PR): size/complexity, diff coverage, a single lint rule, a critic or review finding marked "won't fix".
- **Unlock** (a separate, explicit action, hash-bound, listed in the PR): changing a locked test (A5 or a requirement change), editing a protected path the plan declared.
- **Never:** the secret scan, SHA binding, manifest integrity, "all locked test IDs executed".
- More than 3 waivers in a run parks it.

### 2.9 Config merge (stricter-only, defined per field)
- Allowlists (`allowedModels`, `allowedAgents`, `escapeHatchAllowlist`, registry allowlist) **intersect**.
- Denylists and protected paths **union**.
- Budgets, retry counts, `maxDiffLines`, waiver cap: **minimum**.
- Coverage and quality thresholds: **maximum**.
- `localOnly`: **OR**.
- Commands in `environment.yaml` come only from the stack pack or org/client layers. The project layer can choose from them but can't add new executables.

### 2.10 One ledger
`~/.factory/ledger/<runId>/`, append-only: artifacts, gate results, producer outputs with tool versions, human decisions, usage. The repo gets the manifest only, at deliver. There's no separate `events.jsonl` in the repo.

---

## Part 3. Example

TASK-2 finishes.
1. The core stops the agent container and commits (tree `a1f3…`).
2. The producer runs build + tests in a sealed copy.
3. Predicate: the diff touched `CheckoutTests.csproj`, which is in the lock set. **Fail** (safety).
4. Retry once with that failure. The new tree `b27c…` leaves it alone, and all expected test IDs executed and passed. **Pass.**
5. At deliver, `b27c…` is exactly what's pushed. The PR shows: "1 retry: agent tried to change a locked test project file; blocked."

---

## Part 4. How to explain it

> Every step's result is checked by a small piece of plain code before anything moves on. The checks never trust what the AI says. The factory rebuilds and retests the code itself, in a sealed container the AI can't touch, and fingerprints everything. Approvals are tied to the exact version a human saw. When a check fails, the run retries with the exact error, then a stronger model, then asks a human. Anyone can re-check every decision later from the recorded evidence.

| Question | Answer |
|---|---|
| Can the AI fake the test results? | No. Tests run in a separate sealed container from a copy of the code, and results go straight to the factory's ledger, which the AI can't reach. |
| Can it quietly disable a test? | The factory checks every expected test actually ran, not just "zero failures". Test project files and runner config are locked too. |
| Can an approval be reused for a changed plan? | No. Approvals are tied to the plan's fingerprint. |
| Can I re-check a run later? | Yes: every decision is re-checked from recorded evidence, and the pushed code must match what was checked. |
| What about flaky tests? | Re-run once. If it passes the second time, it's flagged as flaky in the PR, never silently passed. |

---

## 6. Review log (fresh-context review, 2026-09-26)

| # | Finding | Decision |
|---|---|---|
| 1 | Repo code ran outside the sandbox during core test runs (critical) | **Fixed:** sealed producer container, no ledger mount (§2.2) |
| 2 | Lock set too narrow; "0 failures" could hide removed tests (critical) | **Fixed:** wide lock set + expected test IDs executed (§2.4) |
| 3 | "Fails on base" was the agent's claim (critical) | **Fixed:** core producer runs tests on base twice (§2.5) |
| 4 | Approvals not bound to the artifact | **Fixed:** hash-bound approvals, waivers, unlocks (§2.3) |
| 5 | Human identity spoofable on one machine | **Mostly fixed** by host/container separation; single-user identity is a documented POC limit. One-time codes rejected as extra friction once the sandbox is real |
| 6 | Gap between gate check and push | **Fixed:** stop container, tree SHA, push exactly that SHA |
| 7 | Plan could declare its own protected paths | **Fixed:** forces risk ≥ medium |
| 8 | Replay claim overstated | **Fixed:** producer/predicate split; wording is now "re-checks decisions" |
| 9 | Flakiness and known-failure baselines | **Fixed:** no new failures vs baseline; re-run once; fails-on-base twice |
| 10 | Manifest self-verified | **Fixed:** manifest hash posted via forge adapter + ledger |
| 11 | Missing gates (ground, design, impact, arch, a11y, deps, per-commit secrets, G1, G2, D1) | **Fixed** (§2.5) |
| 12 | Ambiguous failure routing | **Fixed:** one ordered ladder + global caps (§2.6) |
| 13 | Review "blocking" decided by the model | **Fixed:** derived by code |
| 14 | "Stricter-only" undefined for lists | **Fixed:** per-field merge rules (§2.9) |
| 15 | "Never waivable" was actually waivable | **Fixed:** separate unlock action (§2.8) |
| Low | Contradictions (lint count, severity labels, two GateDef shapes, two event logs); producer ≠ reviewer check | **Fixed:** 12 lint checks; one GateDef; one ledger; family check in review |
| Simplify | Per-gate routing; waiver-rate statistic | **Adopted:** global ladder; the waiver-rate stat is deferred |
