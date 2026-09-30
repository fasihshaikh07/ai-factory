# First real runs: findings and verdict (2026-09-29/30)

The first runs of the factory on a real client .NET repo, with real models. The repo has 733 tests, of which about 100 already fail on its main branch (the factory only blames *new* failures). The client repo and the run ledgers stay on the owner's laptop. This report has the numbers and findings, with no client code.

## Method
We planted known bugs on local-only branches, so we know the right fix and can judge the factory against it:
- **Bug 1 (unit level):** one line removed that upper-cases a grade in a course-title builder ("Grade k" instead of "Grade K").
- **Bug 2 (api level):** a mock HTTP endpoint made to crash (500) when an id is missing. Before the bug, it generated a new id.

Each run was capped with `--max-cost`. A person answered the question cards and approved the plan in the terminal.

## Runs

| Run | Result | Recorded cost | Active time | Notes |
|---|---|---|---|---|
| Bug 1, before the light lane | stopped at the cost limit, **no code written** | $5.20 | 28 min | full pipeline on a one-line fix: 4 critic passes, an untestable UI criterion, an Opus test writer with 15 integration tests |
| Bug 1, light lane | **delivered**: 1-line fix + 4 unit tests, 19/19 decisions re-check | $1.75 (+≈$0.3–0.6 unrecorded, see F7) | 28.5 min | three factory bugs found and fixed mid-run (F1–F3) |
| Bug 2, light lane | stopped by us in author-tests | $1.33 | 18 min | exposed F4 and F5 |
| Bug 1 with plain Claude Code (no factory) | correct one-line fix | $0.20 | 24 s | **no new test, never compiled**. Found the bug through the "planted bug" commit message, which the factory's agents can't see, so this is an optimistic baseline |

Where the time goes (bug 1, light lane): **test lab ≈ 64%** (the solution is rebuilt 7–8 times per run), coding agents ≈ 20%, model calls ≈ 16%. `factory report <run>` shows model/agent/lab seconds per step.

## Verdict
- **It works end to end on a real repo.** Request → questions → approved plan → tests written first, failing on the old code twice, then locked → fix in a sealed container → full suite with no new failures → app boot → review → local branch with an evidence manifest that re-verifies.
- **Cost is now reasonable for small fixes** (≈$1–1.75), down from $5+ with no result. A plain agent is cheaper (≈$0.20) but writes no test and verifies nothing. The factory's extra cost buys a locked failing test first, sealed verification and evidence.
- **Not yet good enough on time:** 20–30 minutes for a one-line fix, mostly the test lab. That's the first thing to fix after the demo.
- **Real repos expose rule gaps that fakes don't.** Each one below cost a paid retry. Five are fixed; two are open.

## Findings

| # | Finding | Status |
|---|---|---|
| F1 | A criterion describing behaviour that already works ("an upper-case grade stays upper case") passes on the old code by design, and the fails-on-base check retried it forever | **fixed**: such tests are locked as must-keep-passing, as long as some test in the run fails on the old code |
| F2 | Flaky tests were never re-run on repos with more than 20 known failures (the known failures filled the re-run limit), so a timing test parked integrate | **fixed**: only new failures are re-run |
| F3 | Grounding ran out of turns while still reading | **fixed**: the runner says "next turn is your last", and light grounding gets 8 turns |
| F4 | A crash bug's tests fail with an **exception**, which is the right reason, but the check accepts only assertion / not-implemented failures | **open**: accept an exception when the criterion expects a result or a status and the old code throws |
| F5 | The light test writer's 25 turns are too few for api-level tests (bug 2, attempt 1, ran out; $0.42) | **open**: 25 turns for unit criteria, 40 for api/job |
| F6 | The critic didn't see the person's answers, so it flagged decided scope as a defect and paid for a rework | **fixed** |
| F7 | A coding agent's spend is only recorded when it finishes, so interrupted attempts aren't counted | **open**: meter at the key proxy |
| F8 | The in-container build output isn't kept, so a failing agent build can't be diagnosed | **open** |
| F9 | `factory resume` after a pause whose executor died just pauses again | **open** (run resume twice) |
| — | Light lane for small low-risk work: 1 draft, 1 rework, ≤3 questions in one round, `unit` criteria, ui → manual, a Sonnet test writer, budgets capped by the run | **done** |

## For teammates: how to start
1. `factory selftest`: a full run on a sample repo for $0, which checks your machine.
2. Plant a small known bug on a local branch of your own repo, add a project for it (copy your project config, set `baseBranch`), then `factory start "<the symptom in plain words>" --project <it> --max-cost 3`.
3. Watch it with `factory ui` (or `factory logs <run> --follow`). Afterwards: `factory report <run>` and `factory verify-evidence <run>`.
4. Everything a run did is in `~/.factory/ledger/<run>/`:
   - `events.jsonl` (the ledger)
   - `run.log` / `trace.jsonl` (readable trace, secret-masked)
   - `report.json` (scorecard)
   - `cards/` (question, approval, PR text)
   - `artifacts/` (content-addressed inputs and outputs)
   
   These contain your repo's code: keep them on your machine.
