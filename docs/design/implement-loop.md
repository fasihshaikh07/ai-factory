# The implement ⟲ verify loop: two changes (2026-09-29)

## Summary

**What changed**

1. **Every task checks the earlier tasks' locked tests.** Before, a task had to pass only its own locked tests and the characterisation tests. The earlier tasks' locked tests ran too, but their results were ignored, so a later task could quietly break an earlier one and nobody found out until integrate. Now each task must also keep the earlier tasks' locked tests passing. Later tasks' tests are still left out, because the code for them doesn't exist yet.

   When one of those earlier tests fails, the agent is told plainly: *"Your change broke TASK-1's locked test X (AC-1.1): …"*. This is a normal failure that climbs the usual ladder (retry → more effort → stronger model → park). It does **not** trigger the "the same locked test failed twice, maybe the test is wrong" rule, because that test already passed at its own task: the code is wrong, not the test.

2. **A retry keeps the code when only tests or the build failed.** Before, every retry threw away the previous attempt's code and started again from the task's start. Now, if the previous attempt failed only because tests failed or the build broke, and the retry runs at the **same** rung of the ladder, the agent starts from its previous code. It sees its previous diff and is told to fix the failures by editing that change, not to rewrite it. Everything else still starts fresh: safety failures, edits outside the task's files, escape hatches, protected files, secrets, changes to locked tests, agent errors or timeouts, bad test evidence, a crash, and **any move up the ladder** (so a stronger model isn't anchored on a weaker model's approach).

**What it means**

- A task that breaks an earlier task is caught at that task, where the fix is cheap and the agent is told exactly which test and which task.
- A near-miss (one test off, a compile error) costs a small fix instead of a full rewrite. A different approach still comes with the next rung.
- The diff checks still measure the whole task from its start commit, and each task still ends as exactly one commit on the branch.

**What was left out, and why**

- **Integrate sending failures back to a task: deliberately not built.** After change 1, integrate can only fail on flaky tests, on the total diff-size check, or on criteria no task owns. None of those points to one task. And sending a task back changes its commit, which re-runs every later task's coding agent (cost).
- **Running only the tests a change affects: out of scope.** Tests run without AI, so this would save time, not money.

**Also fixed on the way:** in a plan with two or more tasks, a finished later task changed an earlier task's inputs, so the tasks re-ran each other forever. A task now depends only on the tasks before it in plan order. Found by the new three-task end-to-end test.

## Details

### Earlier tasks' tests (`src/stages/build.ts`)

- Ownership is unchanged (`acOwners`): each criterion belongs to the last task in plan order that works on its requirement.
- `earlierTests(plan, owners, tests, taskId)` lists the locked tests owned by tasks before this one. They are added to the task's `expectPass`, next to its own tests and the characterisation tests.
- After the test gate, `labelRegressions(failures, earlier)` rewrites a `locked-failed`, `locked-flaky` or `locked-not-executed` failure on one of those tests into check `regression`, message *"Your change broke TASK-n's locked test <id> (<criterion>): <original message>"*, stack frames kept. The recorded gate result is untouched, so `verify-evidence` still re-checks it.
- Regressions are not counted as locked-test failures (`lockedFailedIds`), so the ladder's test-defect rule doesn't fire. If only regressions failed, the category is "other" and the ladder climbs as usual. An earlier test that didn't run counts as a regression; a "didn't run" on the task's own tests or characterisation tests is still an evidence (safety) failure.
- When the build fails, every expected test is marked "Build failed". Those are left as they are, not relabelled as regressions.

### Keep or reset on a retry (`src/stages/build.ts`)

Decided at the start of `implement/<task>`, before the old reset block:

- `previousAttempt(events, step, checks)` reads the ledger: the last `step.failed` or `step.interrupted` of this step since it last completed. An interrupted or parked attempt counts as "didn't finish".
- `retryMode(prev, rung)` is pure. It keeps only when all of these hold:
  1. there was a previous attempt and it ended in a recorded failure;
  2. every failure check is one of `build`, `locked-failed`, `locked-flaky`, `regression`, `new-failure`;
  3. this attempt runs at the same rung as the previous one.
- Then a worktree check: HEAD must be the commit the factory made on that attempt (stored as `commit` on `step.failed`), a descendant of the task's start commit, with no uncommitted changes. If not, reset.
- **Keep:** the diff start..HEAD is saved to the ledger and shown to the agent as a "Your previous change" section (cut at 40 KB with a note). Then HEAD moves back to the start commit with the files left in place (`git reset --mixed`), and ignored build output is cleaned. The agent's edits and the previous change are committed together, so the task still ends as one commit.
- **Reset:** as before: save the diff, `reset --hard` to the start commit.
- The decision is stored on the existing events: `retryMode` (`keep` or `reset`) and `retryReason` on `step.failed` and `step.completed` data, plus a log line such as *"implement TASK-2: keeping previous attempt's code (the previous attempt failed only on regression; …)"*. No new event type.
- Unchanged: diff gates and the ladder's "same diff again" check measure from the task's start commit; attempt caps and park rules.

### Broken builds

A failed build marks every expected test as a failed locked test ("Build failed"). Those failures no longer count as locked-test failures: a broken build is category "other" with no locked tests named. So two broken builds in a row climb the ladder instead of hitting the "same locked test failed twice" rule and parking the run.

### Tests

- `src/stages/build.test.ts`: `earlierTests`, `labelRegressions`, `retryMode` (keep on test, build and regression failures; reset on a rung move, safety, scope, escape hatch, agent timeout, interrupted, first attempt), `previousAttempt`.
- `src/stages/e2e.test.ts`, "implement loop across tasks": a scripted three-task run on the fake runtime. An out-of-scope edit resets to the start commit. TASK-2 breaks TASK-1's test twice: it gets a regression naming TASK-1, keeps its code on the same-rung retry, climbs instead of parking, starts fresh at rung 1 and passes. TASK-3's tests aren't in TASK-2's `expectPass`. TASK-3's own test fails once and the retry starts from the kept code with the previous diff in its instructions. The branch holds one commit per task.
