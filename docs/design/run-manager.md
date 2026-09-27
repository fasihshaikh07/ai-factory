# Run Manager v2: Simple Design + Explainer (2026-09-26)

Purpose: run a factory job from start to delivery, remember exactly where it is, survive crashes, wait for humans without a process running, and clean up after itself. Owned by Claude (Ahsan, 2026-09-26). v2 applies an independent fresh-context review (19 findings; §6).
Evidence: research-run-manager.md (this component) and research-q-change-partial-concurrency.md (Q3–Q5). Tags: **[docs]** official docs/source, **[preprint]** unreviewed paper, **[anecdotal]** issue reports, **[EVAL]** our estimate, to measure when built.

---

## Part 1. The idea in plain words

The gate engine decides *whether* a step's work is good enough. The run manager decides *what happens next* and keeps the record.

**Analogy: a ship's logbook plus a dispatcher.**
- The **logbook** (the ledger) gets one line per thing that happened, never edited, only appended.
- The **dispatcher** reads the logbook top to bottom and works out the next step. If the laptop crashes, a new dispatcher reads the same logbook and continues from the same place.

Five rules:
1. **The ledger is the only truth.** No database. Current state = replay of the ledger.
2. **Save the result first, then write "done".** A step is done only after its output is safely on disk *and* its "completed" line is in the ledger. A crash in between means the step runs again.
3. **Every step can safely run twice.** Thinking steps are re-runnable by design. Coding steps restart from a clean commit. Anything that touches the outside world (push, PR, Jira) first checks whether it already happened.
4. **Waiting costs nothing.** At a human gate the factory writes a card and exits. The human's command continues it.
5. **Hard stops beat clever recovery.** Caps on attempts, cost and active time. When one is hit, the run **parks** and a human decides.

---

## Part 2. The design

### 2.1 What a run is
| Piece | Where | Lifetime |
|---|---|---|
| Ledger (events + artifacts + cards) | `~/.factory/ledger/<runId>/` | kept per client retention (§2.13); it's the evidence |
| Target repo clone | inside WSL2 / Linux, used only by the factory's git (§2.10) | long-lived, one per project |
| Worktree | `~/.factory/wt/<shortId>/` | created at the first coding step; removed when the run closes; recreated for revise |
| Branch | `factory/<runId>` | kept until the PR merges or closes |
| Containers | agent (A), producer (B), test DB | one per step or check, labelled, removed explicitly |

`runId` = `<yyyymmdd>-<ticket-or-slug>-<4 random chars>`, e.g. `20260926-SHOP-412-k7qd`.

**Platforms:** Linux, macOS, and Windows **via WSL2 only**. The core refuses to start as a native Windows process or with any path under `/mnt/<drive>/`. Microsoft recommends the Linux filesystem, and on `/mnt/c` fsync and file locking are unreliable. [docs + anecdotal, research §1] This also removes all native-Windows rename/EPERM handling.

### 2.2 Run states
```
created → running ⇄ waiting   (a human card is open)
running → parked              (cap hit, ladder exhausted, version changed; a human decides)
running → paused              (pause requested; resumes on request)
running → delivered           (PR open; the run stays OPEN: revise/steer still possible)
delivered → closed: merged | pr-closed
running → closed: not-reproduced | stopped
```
- **delivered is not terminal.** Review comments, CI failures (G2) and "amend" changes (Q3) re-enter `running` on the same run until the PR merges or closes. The forge state is checked on `status` and `revise`.
- **Rejection (G7) is not a state.** A reject reason becomes a change input and the run goes back through the change path; the second rejection parks it.
- Each stage/task: `pending | running | completed | failed | skipped`. "Stale" is not stored; it's computed at replay by comparing inputsHash.

### 2.3 Mode manifests + a tiny interpreter
- A mode is a YAML list of stages (core-design §4, §13): name, `when` condition, runner, gates, retry budget, and whether it's per-task.
- The interpreter is one pure function: `next(state) → Step | Wait | Done` [size EVAL; estimate a few hundred lines].
- Not XState: we borrow its ideas (guards, pure transitions) and persist only our own events, never a library snapshot. XState's docs note event sourcing "can be more reliable" because persisted snapshots can break when the machine changes. [docs, research §8]
- Loops are explicit: `implement ⟲ verify` per task, bounded by the gate engine's failure ladder (gate-engine §2.6).

### 2.4 The ledger
```
~/.factory/ledger/<runId>/
  events.jsonl       one JSON event per line, append-only
  artifacts/<sha256> content-addressed files (spec, plan, results, diffs, logs)
  cards/<cardId>.md  human cards as shown
```
```ts
interface LedgerEvent {
  seq: number; ts: string; runId: string; epoch: number;  // epoch = execution-lock fencing token (§2.9)
  type: EventType;
  key?: string;              // "stage/task/attempt", e.g. "implement/TASK-2/3"
  inputsHash?: Sha;          // §2.5
  treeSha?: Sha;             // coding steps and gates
  outputs?: Sha[];           // artifacts written
  data?: Record<string, unknown>;  // small metadata only, never code
}
type EventType =
  | "run.created" | "run.resumed" | "run.pause-requested" | "run.paused" | "run.parked"
  | "run.stop-requested" | "run.stopped" | "run.delivered" | "run.closed"
  | "step.started" | "step.completed" | "step.failed" | "step.interrupted"
  | "gate.result" | "human.requested" | "human.decided" | "change.received"
  | "sink.intent" | "sink.done" | "usage"
  | "workspace.created" | "workspace.removed" | "container.started" | "container.removed"
  | "ledger.repaired" | "version.changed";
```
**Writing rules:**
- **Appends are serialized by a per-run ledger lock** (held only for the append). Two kinds of writer exist: the executor (§2.9) and short human commands. Nothing else writes: agents and producers run in containers with no ledger mount (gate-engine §2.2).
- **Each append is followed by fsync of `events.jsonl`.** One event per step boundary, so the cost is small.
- **Artifacts:** tmp file in the same folder → fsync file → rename to its sha → fsync the folder. On ext4 a rename survives power loss only after the folder fsync. Written by our own ~20-line helper, since `write-file-atomic` skips the folder fsync. [docs, research §1]
- **Torn last line:** on open, a final line that doesn't parse is truncated and `ledger.repaired` is appended **before** any new append. Appending after a torn line glues two events and silently loses one (real bug reports). A bad line anywhere else = corruption → park. [docs + anecdotal, research §2]
- **Tamper evidence (honest scope):** before deliver, a process running as the same OS user could rewrite the ledger. That's the same POC limit as human identity (gate-engine §2.7). After deliver, the manifest hash posted to the forge anchors it (gate-engine §2.3). No hash chain: it adds nothing against a same-user attacker.

### 2.5 How one step runs
**inputsHash** = hash(input artifact shas, stage definition, prompt template version, model) plus, for coding steps, `taskStartSha`. Factory, SDK and tool versions are **recorded** in `run.created`, not hashed (§2.13).

**Thinking step** (spec, plan, review …):
```
1. completed event with same stage/task + inputsHash exists → skip
2. step.started → runner call (usage appended per model call) → write artifacts
3. step.completed {outputs} → gate.result (pure predicates) → next(state)
```
**Coding step** (author-tests, implement …), matching gate-engine §2.3:
```
1. Same skip rule (taskStartSha is in the hash, so a changed history never skips)
2. step.started; container.started {id}
3. Agent works in container A → finishes
4. Stop container A (kills leftover processes) → container.removed
5. Core commits the worktree (hardened git, §2.10) → treeSha
6. step.completed {treeSha, outputs}
7. Producer container B on a copy of treeSha → gate.result {treeSha} → next(state)
```
**Resume after a crash:** replay → state. A `step.started` with no end becomes `step.interrupted`.
- Thinking step: run again as a new attempt.
- Coding step:
  1. remove its containers (by label, §2.10);
  2. **save** `git diff taskStartSha` plus untracked files as an artifact;
  3. `git reset --hard taskStartSha` + `git clean -fdx`;
  4. re-apply the agent env template (context-builder §2.6) and re-run restore;
  5. start a fresh attempt with the saved diff offered as an optional overlay.
- A crash after step 5 but before step 6 is covered: the commit exists, but without `step.completed` it's treated as interrupted and discarded (saved first).
- Interrupted attempts don't count toward the 6-attempt cap. 3 interruptions of the same step park the run (something environmental is wrong) [EVAL].

**Why a fresh process, never the old transcript:**
- Retrying inside the failed context raised the error ratio 7.1× [preprint]. A fresh rollout with prior edits offered as an overlay improved resolve rate 66.6% → 71.8% [preprint]. Both measure retries after failure, not crashes; we apply them by analogy.
- The Claude Agent SDK docs say passing results into a fresh session "is often more robust" than resuming [docs, research §6].
- The SDK session ID (Claude: init message; Codex: `thread.id`) is recorded for audit only, with `persistSession: false` (VERIFY the option name at build).

### 2.6 Side effects (sinks)
A crash after pushing but before logging it would repeat the push on resume. Durable engines have the same gap; the fix is idempotency at the receiver (Restate re-ran the effect 30/30 times in that window). [anecdotal, Q4]
1. Append `sink.intent {kind, idempotencyKey}`, e.g. `pr:factory/<runId>`.
2. **Look up before create:** the PR by head branch, the Jira comment by a `factory-run:<runId>/<key>` marker, the commit status by context name.
3. Create only if missing, then `sink.done {externalId}`.

Pushing the same SHA to the same branch is naturally idempotent. Sinks run only after their gates pass, so a retry never sends different content.

### 2.7 Humans: waiting, deciding, steering
- **Waiting:** at a human gate the executor writes the card (hash-bound, gate-engine §2.3), appends `human.requested`, sets `waiting`, notifies, releases the execution lock and **exits**. Durable engines use the same shape: a persisted wait plus a message (Temporal signals, DBOS recv, Restate awakeables). [docs, research §9]
- **Deciding:** `factory approve|reject|answer|waive|unlock <run> <hash-prefix>` does four things:
  1. takes the ledger lock;
  2. checks the hash against the ledger **under that lock**;
  3. appends `human.decided`;
  4. releases the lock.

  A repeated identical decision is a no-op. If the run is idle, the command then runs `resume`.
- **Only on a TTY, never via MCP.** The plugin front ends (Claude Code, Codex) get `start`, `status` and `show-card` over MCP, never decision commands. A front-end agent is a model with host access, and a prompt-injected ticket must not be able to approve its own plan (core-design A2).
- **Steer, pause, stop while running:** these append `change.received`, `run.pause-requested` or `run.stop-requested` under the ledger lock. The executor reads them at the next step boundary. `stop` also sends SIGTERM to the executor pid in the execution lock. The executor then kills the current container and appends `run.stopped`.
- **Deadlines** (e.g. the 24-hour default for low-risk questions): any `factory` command that finds an expired deadline appends the default decision as `human.decided {by: "default-timeout"}`. It never starts execution; only `resume` or a human decision does. Wait time never counts toward the wall-clock cap.
- Notifications: terminal + the plugin front end now; Slack/Teams/email later (a sink).

### 2.8 Commands
| Command | Does | Via MCP? |
|---|---|---|
| `factory start <ticket\|brief> --mode --project` | create a run, execute until wait/park/deliver | yes |
| `factory status [run]` / `watch` | state, current step, cost, open card | yes |
| `factory show-card <run>` | print the open card | yes |
| `factory approve\|reject\|answer\|waive\|unlock <run> <hash>` | human decisions | **no (TTY only)** |
| `factory steer <run> <change.md>` | requirement change (Q3) | no |
| `factory revise <run>` | PR comments / CI failures (G2) | no |
| `factory pause\|resume\|stop <run>` | control | no |
| `factory cleanup` | report and remove leftovers (§2.10) | no |
| `factory verify-evidence <run>` | re-check predicates (gate-engine §2.1) | yes |

### 2.9 Two locks
- **Execution lock, one per repo:** held by the one process executing a run on that repo. It uses `proper-lockfile` on `~/.factory/locks/<repoId>`, stores `{runId, pid, host, startedAt, epoch}`, and goes stale after 60 s without a heartbeat. PID alone is never trusted.
  - Every takeover increments `epoch` (a **fencing token**).
  - The executor writes its epoch on every event and refuses to append if the lock's epoch has moved on, so a stale executor that wakes up can't write.
  - On `onCompromised` it stops its containers and exits.

  [docs, research §3; laptop-sleep behaviour EVAL]
- **Ledger lock, one per run:** held only for a single append (§2.4).
- **Several runs per repo** can exist (waiting, parked, delivered). **Only one executes at a time**; others queue with a message.
  - Why: parallel runs need overlap checks and merge-tree logic (agent PR conflict rates 19.8–41.7%, Q5). The lock is per repo now and can become per file-scope later.
  - Tasks inside a run also execute one at a time, in plan order [parallel tasks: EVAL].
- **No repo yet** (greenfield before scaffold, estimate without a repo): the execution lock key is `run:<runId>`. The scaffold stage creates the local repo under `~/.factory/repos/<slug>` (`git init`). From then on it's `repoId`, and the human creates the remote (use-cases GF5).

### 2.10 Workspaces, git and containers
**Hardened git (critical):** every git command the core runs sets:
- `-c core.hooksPath=/dev/null`, `-c core.fsmonitor=false`, `--no-verify`;
- `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1`, so no user-configured filter drivers (LFS etc.) run.

Repo code therefore never executes on the host. LFS repos are refused in the POC [EVAL]. `.gitattributes` and `.gitmodules` join the gate engine's config-integrity set.

**Worktree:**
- Created with `git worktree add ~/.factory/wt/<shortId> -b factory/<runId> <base>` (a short path because of long-path limits) and `git worktree lock --reason "factory run <id>"`.
- The core creates it, not the agent's own worktree feature, so the path and cleanup are ours.
- Apply the project's **agent env template** (dummy values; never real secrets). Real test settings go only to container B via the producer env template (context-builder §2.6, amended 2026-09-26).
- Repos with submodules are refused; the git docs call support incomplete. [docs, research §4]
- **Container A gets the worktree files only, never git metadata:** the `.git` link file is masked, the shared `.git` is not mounted, and the agent has no git. The core does all commits.

**One git per repo:** the target repo lives inside WSL2 and only WSL git touches it. When a repo is used from both Windows and WSL git, each side sees the other's worktrees as "prunable": one cleanup deleted 22 of 40 live worktrees. [anecdotal, research §4]

**Base moves:** before `integrate`, the core fetches the base. If it moved, it rebases the run branch; the branch is core-owned, so rewriting it is safe. A conflict goes to a fresh agent scoped to the task files, and a conflict in a locked or protected file escalates. Integrate then gates the rebased SHA, and that SHA is what's pushed. This covers BF26 and "resume after days". A run resumed after >7 days re-checks the repo profile first [EVAL threshold].

**Manifest commit:** deliver adds exactly one commit on top of the gated SHA, touching only `.factory/evidence-manifest.json`. verify-evidence checks that the PR head's parent = the gated SHA and that the commit changes only that file. (Amends gate-engine §2.3's "pushed SHA = gated SHA" to "pushed = gated + manifest-only commit".)

**Containers:**
- Killing the process that started a container does **not** stop it. So every container gets:
  - labels `factory.run`, `factory.role` (agent|producer|db), `factory.key`;
  - `--init`;
  - its ID logged in `container.started` before start;
  - an explicit end: `docker stop -t <grace>` then remove.
- **Reconciliation is scoped:** on start, resume and cleanup, the core removes labelled containers only for runs whose execution lock is **free**, so a live run on another repo is never touched.
- Ryuk (Testcontainers' reaper) does this automatically, but it is flaky on Podman, so we reconcile ourselves. [docs + anecdotal, research §5]
- **Test DB:** the core starts a throwaway Postgres for the producer on a private network and passes the connection string. Container B never gets the Docker socket, which would be a host escape. Repos whose tests start their own Testcontainers need an override hook, left to the verify-runner design [EVAL].
- **Runtime:** Podman, Rancher Desktop or Docker Engine inside WSL2. Docker Desktop is free only under 250 employees AND under $10M revenue, so Folio3 needs a licence check first. [docs, research §5]

**Cleanup never trusts "prunable":**
- A worktree is removed only when all of these hold:
  - our ledger says its run is closed, stopped, or delivered and idle;
  - its work is safe: pushed, or its diff saved as an artifact.
- Leftovers are reported on every start; nothing is deleted silently.
- Real reports: ~300 uncommitted files lost to an auto-cleanup, and 113 stale worktrees (3 GB) in two months. [anecdotal, research §4]
- `not-reproduced` and `stopped`-before-push runs also delete their unpushed branch.

### 2.11 Caps, clocks and stalls
| Cap | Value | On hit |
|---|---|---|
| Attempts per task | 6 (gate-engine §2.6) | park |
| Run cost | bugfix $5 (was $3; Ahsan 2026-09-27), S $5, M $10, L $20 (our cost model, spec-stage §6a; estimates) | park |
| Active wall clock | 2× the class's expected time, human waits excluded [EVAL] | park |
| Per agent step | runner `maxTurns`, `maxUsd`, timeout (adapters.md) | step fails → ladder |
| Stall | same tool call + args + result 4×, same error 3× (OpenHands' stuck detector); no worktree change in N turns; no event for T min, with build/test commands whitelisted [docs; N, T EVAL] | kill step → ladder |
| Waivers | >3 per run | park |

Cost is the sum of `usage` events. They're appended **per model call**, so a crash loses at most one call's cost.

### 2.12 Changes, linked runs, sequences, partial delivery
- **Change mid-run (Q3), POC form:** `change.received` is applied at the next step boundary.
  - The core classifies it (clarify / amend / new run), then re-runs specify in delta mode and re-plans.
  - **Prefix rule:** tasks are kept from the start of the plan up to the first task whose plan entry changed. From that task on, the worktree resets to that task's `taskStartSha` and everything re-runs. This keeps git history linear with no cherry-picks.
  - Test unlocks always go to a human.
- **Linked runs (G1):** a parent run owns intake → specify, and each repo gets a child run.
  - The backend child locks the API contract, and the frontend child starts from that artifact's hash.
  - Staleness is **computed at replay:** the frontend compares its contract hash with the backend's latest. Nobody writes into another run's ledger.
  - Children stop after integrate and keep their worktrees. The parent runs accept across both, then delivers both PRs, which reference each other.
- **Run sequence (G4, minimal):** the plan gate suggests a split and the human approves it. The parent ledger stores the ordered list, and `factory start --next <sequence>` starts the next run.
- **Partial delivery (Q4):** when a run parks with some tasks passed, the core can open a **draft** PR only. It contains the last gated commit of the passed prefix, re-verified by integrate, with the unmet ACs listed. The human decides whether it becomes ready. Nothing becomes ready automatically.

### 2.13 Versions and retention
- `run.created` records the versions of the factory, mode manifest, stack pack, runners/SDKs and tools.
  - On resume, a changed **manifest or stack pack, or a major runner version** → `version.changed` → park. The human either resumes (the change is logged in the manifest) or restarts.
  - Minor/patch SDK changes are logged only.
  - Nothing re-runs automatically, so approvals are never silently invalidated.
- **Retention:** the ledger keeps everything the predicates read, so `verify-evidence` works as long as the ledger exists.
  - POC default: keep, with `factory cleanup --expire <run>` by hand.
  - Production seam: a client retention policy, with an encrypted or remote store.
  - If the ledger is deleted, the forge-posted manifest hash remains, and the record says the evidence has expired.
  - This updates X9: an audit uses the ledger plus the forge-anchored hash. The repo holds the manifest only (gate-engine §2.10 supersedes A1's "copy ledger into branch").

### 2.14 Observability
`usage` events use OpenTelemetry GenAI field names (`gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`), so they can be exported later. Span export is deferred: the conventions are still at Development status and still being renamed. [docs, research §10]

---

## Part 3. Example: the SHOP-412 bugfix, with a crash and a wait

1. `factory start SHOP-412 --project shop-api` → run `20260926-SHOP-412-k7qd`. The execution lock is taken. Intake → clarify → 3 questions → the card is written, the lock released, and the process exits (`waiting`).
2. Next morning Ahsan runs `factory answer … 3f9a` in his terminal. The decision is appended under the ledger lock and the run resumes: specify → plan → approval card → exits again.
3. `factory approve … c21e` → author-tests (fail on base, twice, locked) → TASK-1 (backend validation) passes → TASK-2 (the toggle) starts.
4. **WSL2 restarts mid-TASK-2.** `factory resume` replays: TASK-2 has `step.started` and no end.
   - Its containers are removed by label.
   - Its diff is saved, and the worktree is reset to TASK-2's start commit.
   - The agent env template is re-applied and dependencies are restored.
   - A fresh attempt starts with the old diff offered. TASK-1 is untouched, because its hash still matches.
5. Before integrate, the base has moved, so the branch is rebased. Integrate → accept → review → deliver: `sink.intent pr` → no PR found for the branch → create it → `sink.done`. The run is `delivered`.
6. A reviewer comments. `factory revise` recreates the worktree from the pushed SHA and fixes the comment through the normal gates. The PR merges, and the run is `closed: merged`.

---

## Part 4. How to explain it

> Every run keeps a logbook that is only ever added to. The factory works out what to do next by reading it, so after a crash it re-reads the logbook and restarts only the unfinished step, from a clean commit. Results are saved before they're marked done. Anything that touches GitHub or Jira checks first whether it already happened. Waiting for a person costs nothing: the factory saves a card and stops until someone decides in their own terminal. Hard limits on attempts, cost and time stop a run cleanly and hand it to a human.

| Question | Answer |
|---|---|
| What if it crashes halfway? | It replays the logbook and restarts only the unfinished step, from a clean commit, keeping the half-done work as a hint. |
| Could it open two PRs after a crash? | No. It looks for the existing PR first, by the run's branch. |
| Does it need a server? | No. It's a command-line program; a waiting run has no process. |
| Why not Temporal or another workflow engine? | They need a server or a database for what is one file per run here. We copy their proven rules: replay, idempotent steps, look-up-before-create, persisted waits. |
| Can the AI approve its own plan? | No. Decisions only work from a human's terminal. The agent runs in a container with no access to the factory, and the plugin front ends can't approve. |
| Can repo code run on my machine? | No. The factory's own git calls disable hooks and filters; builds and tests run only in sealed containers. |
| Can two runs collide on one repo? | Only one executes at a time per repo; others wait. Parallel runs come later with an overlap check. |

---

## 5. Evaluate when built
- **Kill-9 test (this component's acceptance test):** kill the process at every step boundary of a real run. The run must end in the same final state as an uninterrupted one, with no duplicate PR or comment.
- Stall thresholds N and T; the active wall-clock cap; the interrupt-park threshold (3); the days-before-profile-refresh threshold.
- Whether parallel tasks pay off.
- WSL2 sleep and restart behaviour with running containers, and lock heartbeats across sleep.
- The Testcontainers override hook for repos whose tests start their own DB (verify-runner design).

---

## 6. Review log (fresh-context review, 2026-09-26)

| # | Sev | Finding | Decision |
|---|---|---|---|
| 1 | crit | Host git commands ran repo hooks and filters; container A could plant them via `.git` | **Fixed:** hardened git, no git metadata in container A, LFS refused (§2.10) |
| 2 | crit | Approvals over MCP let a front-end agent approve its own plan | **Fixed:** decisions TTY-only; MCP gets start/status/show-card (§2.7, §2.8) |
| 3 | crit | Single writer via the run lock deadlocked human commands; hash check outside the lock | **Fixed:** execution lock per repo + ledger lock per append; hash checked under the lock; signals for stop (§2.4, §2.7, §2.9) |
| 4 | high | Overlay diff lost on reset; clean removed `.env` and deps | **Fixed:** save diff first, re-copy includes, re-restore (§2.5) |
| 5 | high | Loop skipped stop → commit → treeSha; history-blind skip | **Fixed:** coding-step order matches gate-engine; `taskStartSha` in inputsHash; prefix rule (§2.5, §2.12) |
| 6 | high | Manifest commit and rebase vs "pushed = gated" | **Fixed:** rebase before integrate; manifest-only extra commit verified (§2.10) |
| 7 | high | Container reconcile hit live runs; split-brain on stale takeover | **Fixed:** reconcile only free-lock runs; fencing epoch; stop containers on compromise (§2.9, §2.10) |
| 8 | high | Retention deleted evidence; A1/X9 mismatch | **Fixed:** keep predicate inputs; expiry recorded; X9 updated (§2.13) |
| 9 | high | Terminal "done" broke revise (G2) and rejection (G7) | **Fixed:** `delivered` stays open; rejection via change path (§2.2) |
| 10 | med | Crashes hid cost | **Fixed:** usage per model call (§2.11) |
| 11 | med | Deadline check in any command could start execution | **Fixed:** only appends the default decision (§2.7) |
| 12 | med | Versions in inputsHash forced re-approval on upgrade | **Fixed:** recorded not hashed; park on meaningful change (§2.13) |
| 13 | med | Contract drift (RunState, event names, §10, X9) | **Fixed:** contracts §8 + core-design §20 supersede |
| 14 | med | Greenfield/estimate had no repo; linked runs wrote across ledgers | **Fixed:** `run:<id>` lock key; replay-computed staleness; parent accept (§2.9, §2.12) |
| 15 | med | "Edits are detected" overclaimed | **Fixed:** honest scope; hash chain dropped (§2.4) |
| 16 | low | Evidence labels and unsupported sizes | **Fixed:** [preprint] tags, sizes marked EVAL, XState wording, cost caps labelled estimates |
| 17 | low | No fsync after append | **Fixed** (§2.4) |
| 18 | low | Partial delivery at park contradicted "human decides" | **Fixed:** draft only, re-verified (§2.12) |
| 19 | low | not-reproduced left a branch; no container event | **Fixed** (§2.10, §2.4) |
| Simplify | | WSL-only core; no hash chain; no `tick` scheduler; draft-only partials; park on version change; prefix rule for changes; OTel names only | **Adopted.** Kept the OpenHands stall patterns: cheap and evidence-based |
