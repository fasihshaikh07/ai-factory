# AI Factory: Use-Case Catalogue (2026-09-25)

The whole design (core-design.md §1–14, contracts.md, plan-audit.md) walked against every use case we could find across the three modes. **✓** = handled by the current design. **Gap Gn** = a new design change, specified in §5. Hybrid runner per step: **L** = own loop, **A** = wrapped agent, **D** = deterministic.

## 1. Brownfield

| # | Use case | Status | How / gap |
|---|---|---|---|
| BF1 | Feature, API only (.NET/Express) | ✓ | Full pipeline; black-box HTTP ACs |
| BF2 | Feature, API + SPA in one monorepo | ✓ with note | Profile per package; API ACs + Playwright UI ACs; environment boots both |
| BF3 | Feature across two repos (.NET API + Next.js FE) | **Gap G1** | Linked runs, contract first |
| BF4 | Bugfix with a clear repro | ✓ | Repro test fails on base for the reported reason (A3) |
| BF4b | Bug can't be reproduced | **Gap G8** | Explicit "cannot reproduce" outcome |
| BF5 | Defect set (several bugs) | ✓ with note | One task per bug, independent; partial delivery per bug (Q4) |
| BF6 | Refactor / tech debt | ✓ | Characterization before and after (A3, A4) |
| BF7 | Framework or dependency upgrade (.NET 6 → 8) | ✓ with note | Refactor class, always L; split per project via G4 |
| BF8 | DB migration | ✓ | Empty + seeded apply, expand/contract, human approver (Q8) |
| BF9 | Config / CI / infra change | ✓ | Protected paths + named approver; factory never applies it |
| BF10 | Style-only UI change | ✓ | `manual` AC + screenshot + human accept |
| BF11 | Performance requirement ("p95 < 200 ms") | **Gap G9** | Perf harness in the stack pack |
| BF12 | Security fix | ✓ | High risk → extra gate; SAST + second review judge |
| BF13 | New third-party API integration | **Gap G6** | Fakes authored with the tests, then locked |
| BF14 | Repo with no tests (your React repo) | **Gap G3** | Bootstrap-tests run first |
| BF15 | Red baseline | ✓ | Stop and report; optionally a bugfix run to fix the baseline |
| BF16 | Repo with no linter | ✓ | Stack-pack defaults, new code only |
| BF17 | Large repo (>300 files) | ✓ | graphify as a query tool |
| BF18 | Jira ticket with Figma/Confluence links | ✓ | Sources at intake; MCP reads in L stages |
| BF19 | Ambiguous ticket, human slow to answer | ✓ | Low-risk assumptions default on timeout; high-risk block |
| BF20 | Ticket contradicts existing code or docs | ✓ | Ground stage anchors → question on the card |
| BF21 | Ticket too big for one PR | **Gap G4** | Split into a run sequence |
| BF22 | Requirement changes mid-run | ✓ | change-NN, stale marking, human unlock (Q3) |
| BF23 | Locked test is wrong | ✓ | Test-defect escalation (A5) |
| BF24 | Human reviewer comments on the delivered PR | **Gap G2** | Revise entry point |
| BF25 | Forge CI fails after delivery | **Gap G2** | Same revise entry point |
| BF26 | Base branch moved / conflict | ✓ | Rebase, then full re-verify before deliver (Q5) |
| BF27 | Crash mid-run | ✓ | Resume from ledger by inputsHash (Q4) |
| BF28 | Budget exhausted | ✓ | Stop, draft PR of passing tasks, escalate |
| BF29 | Human rejects at the approve gate | **Gap G7** | Rejection becomes a change input |
| BF30 | Run stopped / abandoned | ✓ with note | `factory stop`: ledger marked, worktree removed, branch kept |

## 2. Greenfield

| # | Use case | Status | How / gap |
|---|---|---|---|
| GF1 | New single-stack app from a brief | ✓ | decide-architecture (ADR, human) → blueprint scaffold → brownfield path |
| GF2 | New full-stack app (API + SPA) | **Gap G1** | Contract-first linked runs, same as BF3 |
| GF3 | Stack with no blueprint (Next.js) | **Gap G11** | Next.js stack pack + blueprint |
| GF4 | Initial scope is many features | **Gap G4** | Spec → run sequence (walking skeleton first) |
| GF5 | Creating the remote repo | ✓ with note | Deterministic forge sink after human gate; POC: human creates it, factory pushes |
| GF6 | CI pipeline for the new repo | ✓ | From blueprint; protected afterwards |

## 3. Estimate + MVP

| # | Use case | Status | How / gap |
|---|---|---|---|
| ES1 | Brief text → estimate sheet (xlsx) | ✓ | clarify/specify (L) → breakdown (L) → code math (D) |
| ES2 | Brief with PDFs, RFP or Figma | ✓ with note | Attachments extracted by L stages; every claim cites its source page |
| ES3 | Estimate for a change to an existing client repo | ✓ | discover + impact feed leverage tags and ranges |
| ES4 | Disciplines outside our stacks (Mobile, Design, PM, QA) | ✓ with note | Ratios from past sheets, labelled; prototype is web only |
| ES5 | Client changes the brief after the estimate | ✓ | Same change mechanism; estimate v2 with a diff against v1 |
| ES6 | Client needs to click the MVP | **Gap G10** | Preview packaging |
| ES7 | Estimate accepted → start building | **Gap G4** | Estimate's spec + breakdown seed the greenfield run sequence (no re-spec) |
| ES8 | Calibration from actual effort | ✓ (later) | Actuals per task logged by every build run |

## 4. Cross-cutting

| # | Use case | Status | How / gap |
|---|---|---|---|
| X1 | User picks vendors per stage | ✓ | Config check fails early when a stage has no usable route (§14) |
| X2 | Local-only client policy | ✓ with note | Allowed; think stages on local models are flagged "reduced rigor" on the approval card |
| X3 | Start from Claude Code, Codex or Cursor | ✓ | One MCP server + thin manifests |
| X4 | Many clients/projects, different configs | ✓ | Layered config; security only tightens |
| X5 | Bitbucket or GitHub | ✓ | Forge sink adapter |
| X6 | Secrets in repo content sent to model APIs | **Gap G5** | Context-pack redaction (new because of the hybrid) |
| X7 | Prompt injection in ticket or repo text | ✓ | L loop has no write/shell/network tools; sinks only after gates |
| X8 | Vendor outage / rate limit | ✓ | Backoff (not a retry), then next vendor on the ladder |
| X9 | Audit months later | ✓ | Ledger (kept per retention) + manifest in the repo + manifest hash posted to the forge (run-manager §2.13) |
| X10 | Factory changed: did it get worse? | ✓ | Eval smoke set per change, full set before routing changes |
| X11 | Developer on Windows (.NET shops) | **Gap G12** | Platform support |
| X12 | Two runs on one repo | ✓ (deferred) | Lock file now; overlap check later (Q5) |

## 5. Gap designs (proposed; added to core-design.md §15)

- **G1 Linked runs (multi-repo / full-stack).**
  - One parent run owns intake → clarify → specify, and splits the requirements per repo.
  - The API contract (OpenAPI delta) is a locked artifact produced by the backend run's plan.
  - The frontend child run starts from the locked contract and uses MSW fakes generated from it.
  - The parent's accept stage boots both and runs the cross-repo UI ACs.
  - Each repo gets its own PR, and the PRs reference each other.
- **G2 Revise entry point.** `factory revise <run>`, or a forge webhook later, takes PR comments or CI failures.
  - An L stage classifies each item as a code fix (→ implement with failures.json), a requirement change (→ Q3 change path) or "won't fix" (→ reply drafted for the human).
  - Locked tests stay locked unless the change path unlocks them.
- **G3 Bootstrap-tests run.** For repos with no test harness:
  - The stack pack adds the harness (Vitest + Testing Library + Playwright; xUnit + WebApplicationFactory).
  - Characterization tests are then written for the modules a request touches.
  - It ships as its own PR, which must merge before feature runs on that repo.
- **G4 Run sequence.** When the plan exceeds the size budget (or for a greenfield or estimate hand-off):
  - The planner emits an ordered list of runs (walking skeleton first), each with its own REQ subset.
  - The spec is shared and each run gets its own PR.
  - The human approves the sequence once.
- **G5 Context redaction.** Before any L or A call:
  - gitleaks (redact mode) scans the context pack, and `.env*`, key files and policy-listed paths are excluded.
  - A hit blocks the call, rather than silently sending the secret.
- **G6 Locked fakes.** For new external integrations, author-tests also writes the WireMock/MSW fakes from the vendor's docs or OpenAPI. The fakes are locked with the tests. Optional E2 smoke test against a sandbox, core-run only.
- **G7 Rejection loop.** A rejected approval card needs a reason. The reason becomes change-NN, and stale stages re-run. After 2 rejections the run parks for a conversation.
- **G8 Cannot reproduce.** If the repro test passes on base after 2 attempts, the run ends with "not reproduced". It reports the attempted repro and asks for steps. No code change is made.
- **G9 Performance NFRs.** The stack pack has a benchmark command (k6 for HTTP, BenchmarkDotNet for .NET). An NFR metric becomes an accept-stage check against the baseline measured in discover.
- **G10 MVP preview.** The prototype builds to a static bundle with MSW and a "mock-up" banner. It's delivered as a zip plus an optional preview deploy after human approval (sink).
- **G11 Next.js stack pack + blueprint.** Needed for your frontend and for GF3.
- **G12 Platforms.** POC: Linux, macOS, and Windows via WSL2 (Docker/Podman required for E1 tests and the sandbox).
