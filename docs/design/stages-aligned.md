# AI Factory: Aligned Stage Catalogue (2026-09-27)

One reconciled view of every stage, per the precedence rule (newest wins): verify-runner > context-builder v2 > run-manager v2 > gate-engine v2 > core-design (incl. §13–§23, later sections win) > contracts (§8–§10 win) > spec-stage > adapters > use-cases > plan-audit > workflow-design > open-questions-answers > explainer, dry-run-shop. Research files are evidence only.

**Doc keys:** VR verify-runner · CB context-builder · RM run-manager · GE gate-engine · CD core-design · CT contracts · SS spec-stage · AD adapters · UC use-cases · PA plan-audit · WD workflow-design · OQ open-questions-answers · EX explainer · DR dry-run-shop · OSS oss-map · RU reuse · RJ research-jcode · RL research-local-second-opinion.

**Runner keys:** **L** = own LLM loop, "thinking" (ApiRunner, read-only tools served by the core; CD §14, §18; AD Part 2) · **A** = coding agent in container A (Claude Agent SDK / Codex SDK / jcode; CD §18) · **D** = deterministic core (producers in containers R/B1/B2 + pure predicates; GE §2.1, VR §2.2) · **H** = human on a TTY (RM §2.7).
**Trust:** **LR** = locked room: no write/shell/network, no model-driven MCP, repo tools rooted at a tracked-files snapshot, may read untrusted text (CB §2.2). **CA** = container A: may write, never sees untrusted text or MCP (hard build error, CB §2.2). **Core** = host process, no model.
**Budget classes (CB §2.4, all [EVAL]):** read-small 15K · read-large 30K · agent 40K; SS §1 overrides the spec sub-steps. Local packs ≤16K (CB §2.11).
**Tiers (WD §4):** T0 local · T1 small hosted (Haiku 4.5) · T2 mid (Sonnet 5) · T3 frontier (Opus 5.5 / GPT) · T4 top. Before plan, route on change class + risk only; S/M/L applies from author-tests on (CD §13 B3).

---

## 1. Canonical stage order per mode

**Brownfield** (CD §13 "Updated brownfield pipeline", §16, SS §1, CB §2.8, RM §2.10, GE §2.5):
```
discover (once per repo; refresh per run)
  ├ D: inventory → DB schema read (read-only, D9) → baseline (VR §2.9) → conventions/doc-claims/test map
  └ L: discover-read (repo docs + agent files → candidate rules) → [onboarding card, H once]
intake → ground → clarify { sketches ×3 → clarifier → ask ≤5 [question card, H if needed] }
  → specify ×3 → merge → lint (D) → critic → round trip { restater → aligner → D }  (repair loop ≤3 → specify)
  → spec gate (D)
  → design*  (UI changes only)
  → impact → plan (+≥2 options + ADR, + interface stubs)
  → [approval card: spec+plan in one, H unless auto-proceed]     (+ migration approver, Q8)
  → stub commit (D) → author-tests + characterization (A)  → run on base ×2 → lock (D)
  → per task, in plan order: implement (A) ⟲ task verify (D)      [failure ladder GE §2.6; A5 test-defect check]
    (update 2026-09-29: each task also re-checks earlier tasks' locked tests; a retry keeps its code after a test or build failure at the same rung; see docs/design/implement-loop.md)
  → base moved? rebase (D) → conflict-resolve (A, conditional)
  → integrate (D) → accept (D) → review (L) → deliver (D) → [merge, H always]
  → delivered (still open): revise (G2) / steer (Q3) until merged or closed (RM §2.2)
```
**Greenfield** (CD §4, §15; RM §2.9; VR §2.9; OQ Q12; UC GF1–GF6):
```
intake → clarify → specify (×3, merge, lint, critic, round trip; no ground) → design* → decide-architecture [ADR sign-off, H]
  → [approve] → scaffold (A: official generator + blueprint overlay; local repo ~/.factory/repos/<slug>) → baseline (D)
  → discover (after scaffold) → continue as brownfield from impact/plan → … → deliver (human creates the remote, GF5)
  (G4: a large scope becomes a run sequence, walking skeleton first)
```
**Estimate** (CD §4, §8; UC ES1–ES8; CT §2 estimate mode):
```
[discover if a repo exists] → intake → clarify → specify → design* → [impact if repo: feeds risk/leverage, ES3]
  → breakdown (L) → estimate (L tags + D arithmetic + xlsx) → [presales approval, H] → prototype (A; design mock promoted; G10 zip)
  (ES7: an accepted estimate's spec + breakdown seed a greenfield run sequence, no re-spec)
```
**Cross-cutting flows**
- **Change mid-run (Q3)**: `factory steer` → `change.received` → applied at the next step boundary → core classifies clarify / amend / new run → specify in delta mode → re-plan → **prefix rule**: keep tasks up to the first changed plan entry; reset to that task's `taskStartSha` and re-run the rest → test unlocks always go to a human (RM §2.12). Rejection at a card (G7) enters the same path; the 2nd rejection parks (RM §2.2).
- **Revise (G2)**: `factory revise` → worktree recreated from the pushed SHA → **L/LR** step turns each PR comment / CI failure into a structured item (failure record, AC change, or won't-fix reply) → **TTY card** confirms items → code fixes go to implement with failures.json; requirement changes take the Q3 path → normal gates → deliver (CB §2.2, GE §2.5, UC G2, RM §2.2).
- **Linked runs (G1)**: parent run owns intake → clarify → specify and splits REQs per repo; backend child's plan locks the API contract; frontend child starts from that contract's hash (derived trust, CB §2.2) with MSW fakes; children stop after integrate and keep worktrees; parent runs accept across both apps in one namespace (VR §2.8), then delivers both PRs, which reference each other; staleness computed at replay; a backend revise marks the frontend stale (RM §2.12, GE §2.5, UC G1). Required, not optional (CD §16 D2).
- **Run sequence (G4, minimal)**: spec lint L9 / plan size check suggests a split; human approves once; `factory start --next` (RM §2.12, SS §4).
- **Cannot reproduce (G8)**: repro test passes on base after 2 attempts → `closed: not-reproduced`, unpushed branch deleted (UC G8, RM §2.2, §2.10).
- **Partial delivery (Q4)**: on park with a passed prefix, a **draft** PR only, re-verified by integrate, unmet ACs listed; a human decides (RM §2.12, GE §2.6).

---

## 2. Stage catalogue

Format: **purpose** · runner / model · inputs → output · gate(s) after · human · budget · trust.

### Onboarding
| Stage | Purpose | Runner / model | Inputs → output | Gate after | Human | Budget | Trust |
|---|---|---|---|---|---|---|---|
| discover (D part) | Learn how to build/test the repo; record a baseline | D (inventory, DB schema read-only, baseline via VR) | repo HEAD, env contract, dev DB (read-only, D9) → `repo-profile`, `baseline`, conventions, `test-run`/`lint-run`/`audit-run` | baseline recorded + tool versions stamped (GE §2.5); `red` stops; refusals named (Postgres only; Testcontainers, SQL Server, Windows-only, LFS, submodules, `next/font`) (VR §2.5, §2.9; RM §2.10) | onboarding card once per repo: refusals, mixed conventions, tracked secrets, no-go globs, candidate rules (WD §1; CB §2.2, §2.6) | – | Core |
| discover-read | Turn repo docs and human-written CLAUDE.md/AGENTS.md into candidate rules; module summaries | L, T0/T1 local (WD §4; RJ) | tracked-files snapshot (untrusted docs/agent files) → candidate conventions, doc claims | schema | via the onboarding card (accept all in one click, CB §2.2) | read-small 15K | LR |

### Spec pipeline (SS §1; all L sub-steps are LR, CB §2.2)
| Stage | Purpose | Runner / model | Inputs → output | Gate after | Human | Budget | Trust |
|---|---|---|---|---|---|---|---|
| intake | Split request into intent spans; class, risk, touchesUi | L T0/T1 (Haiku/local) + D rules; risk = max(rules, model) (SS §6a; CD §13 B6, §17) | prompt (primary; treated as untrusted like a ticket since operators paste emails; stored with hash, operator, time and answers; quoted in the PR) and/or ticket (core-fetched, untrusted) → `intent` (Ahsan 2026-09-27: prompt is the main brownfield input) | schema; risk = max(rules, model) (GE §2.5) | – | 8K (SS) | LR |
| ground (brownfield) | Anchor current behaviour to file:symbol | L T3 Opus 5.5 + D, ≤8 turns (Ahsan 2026-09-27: ground is frontier; anchor gate catches invented anchors but not missed ones) | intent, repo map, `read_file`/`search` → `current-behaviour` | every anchor resolves (GE §2.5) | – | 40K (SS; not in CB's class list) | LR |
| clarify: sketches ×3 | Independent readings; disagreement = ambiguity | L T2 Sonnet 5, 3 samples; not local (RL) | intent, current-behaviour → 3 behaviour lists | (feeds clarifier) | – | 3 × 6K (SS) | LR |
| clarify: clarifier | Turn disagreements into scored MC questions | L T3 Opus 5.5, effort medium (SS §6a) | intent, CB, sketches, disagreement table → `questions` | ≤5 questions; high-risk assumptions flagged (GE §2.5) | – | 20K (SS) | LR |
| clarify: ask | Ask only if impact×uncertainty ≥4, max 5 | D → H | top questions → answers / ASM-n; if answers open new disagreements over the threshold, one more round of at most 3 (max 8 questions total; supersedes C23 for clarify; research-e2e-prompt-ground.md) | – | **question card**; skipped if none clears the threshold; low-risk defaults after 24h via `default-timeout`, high-risk waits (SS §2, §8; RM §2.7) | – | Core |
| specify ×3 | Three independent EARS + G/W/T drafts | L: 2× Opus 5.5 + 1× GPT for medium/high risk; Sonnet 5 for low-risk bugfix (SS §6a) | intent, answers, assumptions, current-behaviour → 3 drafts | – | – | 3 × 30K (SS) | LR |
| merge | Merge drafts; stability = drafts/3 | L Opus 5.5 medium + D source check | 3 drafts → `spec` + alignment | every `from` exists (SS §3.4) | – | 40K (SS, CB) | LR |
| lint | 12 deterministic checks L1–L12 | D | spec → lint results | blocking except L12 (advisory) (SS §4) | – | – | Core |
| critic | Adversarial rubric (8 items incl. D4 state, D5 blast radius, D3 literals) | L GPT (other family), fresh, effort high | spec + intent + current-behaviour (no drafts) → findings | blocking derived by code from severity (GE §2.5) | – | 30K (SS) | LR |
| round trip | Restate from spec only; detect dropped/invented | L restater Sonnet 5 + aligner Haiku/local + D | spec, intent spans → dropped spans, inventions | round trip clean (GE §2.5) | – | 2 × 15K (SS) | LR |
| spec gate | Auto-proceed or fold into the approval card | D | all of the above | auto only if all SS §5 conditions hold; repairs ≤3 then findings go on the card | → approval card | – | Core |
| design* (UI only) — **update 2026-09-29: the scripted part (UI change size, style checks, brief cleaner) is built; see `docs/design-step.md`** | Flow (Mermaid) + React mock; REQ↔screen map | **Undecided** (see §3 C10): LR read-large per CB §2.2/§2.4 vs wrapped agent per CD §14; model unspecified | spec (+ Figma/images, untrusted) → `design` | no unmapped REQs, no orphan screens (GE §2.5) | on the approval card (mockUrl) | read-large 30K | LR (reading) |

### Planning and approval
| Stage | Purpose | Runner / model | Inputs → output | Gate after | Human | Budget | Trust |
|---|---|---|---|---|---|---|---|
| impact | Files touched, consumers, missing tests, risk | D (compiler/refs) + L (DR §1; CD §14); tier unspecified | spec, repo map/graph → `impact` | risk ≤ policy or human; blast-radius flag → risk high (GE §2.5; CD §16 D5) | card if risk above policy | read-large 30K | LR |
| plan | Tasks with file scope, exemplar, ≤15 rules; ≥2 options + ADR; interface stubs; linked contract | L, T3 (Opus 5.5) always, effort high (Ahsan 2026-09-27: plan is always frontier) (WD §4; AD config) | spec, impact, conventions → `plan`, stubs | REQs covered; ≥2 options + ADR; scopes don't overlap; ≤15 rules/task; declared protected path forces risk ≥ medium (GE §2.5) | – | read-large 30K | LR |
| approval card | One card: files the plan will touch (from task file scopes, so a grounding miss is visible), answers, high-risk assumptions (D7), unstable REQs, critic, options/ADR, test names per AC (A5), risk note typed by approver | D → H (`factory approve <run> <hash>`, TTY only) | spec + design + impact + plan → `approval` | hash-bound (GE §2.3) | **skipped** only when SS §5 all green AND low-risk class AND internal ticket; **always** for auth, payments, PII, migrations, public API, client briefs, estimates (CD §3b); medium risk adds the spec approver (CD §13 B5) | – | Core |
| decide-architecture (GF) | Per-project choices only, as short ADRs over the org blueprint | L (thinking; CD §14 by rule) + H; model unspecified | brief spec, blueprint → `adr` | human sign-off (CD §3) | **ADR sign-off** | unassigned | not listed in CB §2.2 |
| breakdown (ES) | Module → task list with min/max, leverage tags | L T2/T3 (WD §4) | spec, design → `work-breakdown` | every REQ → ≥1 task (CD §3) | – | read-small 15K ("estimate") | LR |
| estimate (ES) | Buffers, rollups, cost, xlsx | L tags + **D arithmetic** (ExcelJS) | breakdown → `estimate` | all numbers by code (CT §5) | **presales approval** (CD §4) | read-small 15K | LR |

### Building
| Stage | Purpose | Runner / model | Inputs → output | Gate after | Human | Budget | Trust |
|---|---|---|---|---|---|---|---|
| stub commit | Signatures that throw not-implemented, so tests compile | D (hardened git) | plan stubs → commit on branch | shown on the plan card (CB §2.8) | – | – | Core |
| scaffold (GF) | Official generator + blueprint overlay; `git init` | A (+D) (CD §3, OQ Q12) | ADR, blueprint → new local repo | baseline recorded on scaffold commit (VR §2.9) | human creates remote (GF5) | agent 40K | CA |
| author-tests + characterization | One black-box test per AC (HTTP/job/outbound/DB/UI, D1); characterization of neighbours (A4); fakes for externals (D8, G6) | A, fresh process, family ≠ implementer; T2 (S) / T3, effort high (WD §4) | ACs, stubs, harness rules, 1 exemplar; **never the plan's approach** (CB §2.4) → `acceptance-tests` | producer runs new tests on base+stubs **twice**: each AC fails with `assertion` or `not-implemented`; characterization passes; lock recorded (GE §2.5, VR §2.4); per-class gate (CD §13 A3) | – | agent 40K | CA |
| implement (per task) | Make the task's locked tests pass inside file scope | A: Sonnet 5 → Opus 5.5 (AD config; WD §4 T2→T3, L = T3 high) | plan task, rules, pointers, failures.json (≤20 signatures) → commit (treeSha) | **task verify** (D): build + unit + scoped tests; locked AC tests pass first run; diff in scope; lock + config-integrity sets unchanged; no escape hatches/skip/deleted tests; 0 new lint vs baseline; secrets; new-deps ≥30 days (GE §2.5, VR §2.4, §2.7) | unlock card if A5 says "test wrong"; waivers | agent 40K; session cap ~50% window | CA |
| A5 test-defect check | Same locked test fails twice: test wrong or code wrong? | fresh reviewer (runner/model unspecified) | AC + test + failure → verdict | – | **unlock card** (AC and test side by side) | unassigned | – |
| conflict-resolve (cond.) | Resolve rebase conflicts when base moved | A, fresh, scoped to task files | conflict → rebased branch | conflict in locked/protected file escalates (RM §2.10) | escalation | agent 40K | CA |
| integrate | Whole-branch proof | D: full build + suite, architecture (only if repo has rules), migrations, diff coverage (**integrate only**), OSV + NuGet audit, new deps, a11y (VR §2.7) | rebased treeSha → `test-run`, `audit-run`… | no new failures vs baseline; all locked + characterization IDs executed and passed; size/coverage; `upstream` class for base failures (GE §2.5, VR §2.9) | waivers (coverage, size, lint rule) | – | Core |
| accept | UAT evidence per AC | D: db → migrations → app → health → AC replays; evidence = HTTP, screenshots + axe, DB rows, locked fakes' request logs; **no recording proxy** (VR §2.8) | locked tests, fakes → `AcceptEvidence` | every AC has evidence of its kind (GE §2.5) | `manual` ACs (style-only UI) need human accept (CD §13 A3) | CB lists read-small 15K; model role undefined | Core (+LR if a model is used) |
| review | Correctness, spec mismatch, error handling, security, reuse; forged-report attack (VR §2.4) | L, T3 **other family** (GPT per AD config), effort high; +2nd judge if high risk (WD §4) | diff, ACs, intent spans, verification summary → `review` | blocking derived by code (category + confidence); family ≠ implementer or noted (GE §2.5) | waiver "won't fix" | read-large 30K | LR |
| deliver | Push gated SHA + one manifest-only commit; PR with trace | D: gitleaks on every commit; sinks intent → look-up → create (RM §2.6) | ledger → PR, `evidence-manifest.json`, manifest hash posted to forge | manifest complete; pushed = gated + manifest-only commit (RM §2.10) | **PR merge, always** | – | Core |
| prototype (ES) | Clickable React+Vite mock with banner; static zip | A (CD §14) | design mock, breakdown → bundle | builds and runs; banner; Playwright visits routes (CD §3; RU §9) | preview deploy only after approval (G10) | unassigned | CA |

**Other human touchpoints:** park decisions (caps: 6 attempts/task, cost bugfix $5 (raised from $3, Ahsan 2026-09-27) / S $5 / M $10 / L $20, 2× wall clock, >3 waivers, 3 interruptions, `version.changed`) (RM §2.11, §2.13); read-step pack over budget parks with a card (CB §2.5); migration/config/CI approvers per change type (OQ Q8). Decisions are TTY-only; MCP front ends get only `start`, `status`, `show-card` (RM §2.7–§2.8).

---

## 3. Contradictions and leftovers (resolved by precedence)

| # | Where | What | Winner → resolved statement |
|---|---|---|---|
| C1 | CD §9–§10, CT header, EX locked decision 2, OQ Q6/Q7, RJ adapter | `events.jsonl` and run files under `<repo>/.factory/runs/`; A1 "copy ledger into branch" | RM §2.4, §2.13; GE §2.10; CD §19–§20 → one ledger at `~/.factory/ledger/<runId>/` (events.jsonl + content-addressed artifacts + cards). The repo gets **only** `.factory/evidence-manifest.json` at deliver; the manifest hash is posted to the forge. |
| C2 | CD §6 (generated AGENTS.md), RU §2 (Agent OS for AGENTS.md generation), WD §1 step 8 / §2 (export native rule files), CD §5 (Codex plugin "skills + AGENTS.md") | Who writes agent instruction files | CB §2.9 → no generated AGENTS.md by default; client agent files are masked and never auto-loaded; they're read only in discover-read and turned into candidate rules. Any native-format export is written by the **core** as a separate human-approved diff, never by an agent; agent files at any depth are in the config-integrity set (GE §2.4). |
| C3 | CD §6a (graphify in discover, its MCP given to agents), CT `codeIntel`, PA §G (cut) | graphify default | CD §6a update + WD §1 + CB §2.2 → default is an Aider-style tree-sitter map (≤2–4K) + search; graphify only >~300 files or on request, as `graph_query` **served by the core** in locked-room steps (no model-driven MCP); doc/PDF extraction (LLM) off; never `graphify <agent> install`. |
| C4 | OQ Q1/POC table, OSS, CD §15 & §16 D9, CT `services.kind`, DR §5, RM §2.10 (override hook) | Testcontainers for E1 | VR §2.5 (+ CT §10) → POC: the core provides a throwaway **Postgres** (non-superuser, shared network namespace, loopback only). Repos whose tests use Testcontainers are **refused**; so are SQL Server and Windows-only targets. No Docker socket anywhere; no Ryuk. |
| C5 | CT `Environment.envFile`, OQ Q1 "own test env files", RM review-log #4 ("re-copy includes") | `.env` include-list copied into the worktree | CB §2.6 (RM §2.5/§2.10 amended) → no live secrets where a model acts: **agent env template** (dummy values) → container A; **producer env template** → container B only. Path excludes: `.env*` except `*.example`, `appsettings.*.json` except base, keys, etc. |
| C6 | CD §3c, WD §1 (profile ≤8–15K), CB §2.4 vs SS §1 | Budgets | CB §2.4 → three classes in the mode manifest; **SS §1 overrides the spec sub-steps** (intake 8K, ground 40K, clarifier 20K, drafts 30K, merge 40K, critic 30K, round trip 15K). Local ≤16K. All [EVAL]. |
| C7 | SS §6a "at the cap, deliver passing tasks as a draft PR and escalate"; OQ Q4 "ready PR for passing tasks" | Behaviour at cap / partial success | RM §2.11–§2.12, GE §2.6 → cap hit = **park**; partial delivery is a **draft** PR only, re-verified by integrate, and a human decides. |
| C8 | CD §3/§5, CT `StageName`, EX, WD §5 | Stage names | "verify" = per-task producer run (VR `VerifyStage: task`) then `integrate` (CD §13 B7). "approve-plan" (CD) = "approve" (CT) = approval card fed by the spec gate (SS §5). "onboard" (EX) = discover. "characterization" (CD §14) runs inside author-tests. `conflict-resolve`, `revise`, sketches/merge/critic/round-trip, stub commit and A5 check are missing from CT `StageName` — **leftover**: add them. |
| C9 | CD §3 (review = A; intake D; ground/impact D+A; plan A), EX ("never calls a model; we don't build a harness"), CD §11 ("own agent loop: avoid"), RU §1 (skip Vercel AI SDK: "core never calls a model") | Who runs thinking stages | CD §14 (locked) + §18 + AD → thinking stages run in the own loop (ApiRunner: `@anthropic-ai/sdk` + `openai`); coding stays in wrapped agents. The Vercel AI SDK candidate is dropped (CD §18). |
| C10 | CD §14, DR §1 (design = wrapped agent) vs CB §2.2/§2.4 (design = locked-room read-large) | Design stage runner | CB wins for anything reading Figma/images (untrusted, LR only, CB §2.7). **Undecided:** who writes the React mock files; per CB's hard rule a writing step may take only the derived `design` artifact. |
| C11 | CD §13 E, GE §2.5 accept row ("replay with recording"), CB §2.4 (accept = read-small LLM step) | Accept mechanics | VR §2.8 → no recording proxy; evidence from locked fakes' logs, screenshots, axe, DB rows; the stage is deterministic. What a model does in accept is **undefined** (leftover in CB). |
| C12 | CT §2 `failureKind="assertion"` only | Fail-on-base rule | CB §2.8 + VR §2.4 → on base + stubs, `assertion` **or** `not-implemented` counts as expected failure. |
| C13 | CD §3a, §3, WD §3, DR (10 lint checks) | Spec lint count | SS §4, GE §2.5 → 12 checks (L11 surface, L12 literal IDs advisory). |
| C14 | CD §5, PA §G ("factory approve" over MCP), OQ Q11 (approve from the plugin) | Approvals from front ends | RM §2.7–§2.8 → decisions only on a TTY; MCP gets start/status/show-card/verify-evidence. |
| C15 | CD §5 item 3 (git pre-push hook) | Enforcement via hooks | RM §2.10 → hardened git disables all hooks/filters; enforcement = core-only deliver + manifest check + forge branch protection. |
| C16 | CD §10b, §10c (`tools: specify: [jira.read, figma.read]`), CD §14, CT §7 (`mcp:*` tools), RU §7 (Atlassian/GitHub MCP as agent read tools) | Model-driven MCP | CB §2.2 → no model-driven MCP anywhere; external docs are fetched by the core by ID and inlined as untrusted sections. MCP servers are at most a transport the core calls for sources/sinks. |
| C17 | UC G5, AD Part 2 step 2 ("a secret hit blocks the call") | Secret handling in packs | CB §2.6 → path excludes + gitleaks (network verification off) replace hits with `«SECRET_n»` placeholders and record them; the real control is no live secrets in container A. |
| C18 | AD (Ollama through the `openai` client) | Ollama API | CB §2.9, §2.11 → native `/api/chat` with explicit `num_ctx`, `truncate:false`, `shift:false` (flags VERIFY). |
| C19 | RU §5, OSS (Stryker, diff-cover, Betterleaks, npm audit/`dotnet list --vulnerable`), WD §3 (diff coverage per task) | Verify tools | VR §2.7 + simplify → mutation **off** (flag); diff coverage at **integrate only**, computed in TS (no diff-cover/Python); gitleaks only; NuGet audit in R + OSV-Scanner on the host. |
| C20 | RM §2.10, CD §15, OQ Q1 (Docker Desktop/Rancher), RU §4 (srt optional), CD §22 (bubblewrap fallback) | Container runtime | CD §22 + VR §2.11 → Docker Engine CE or Podman inside WSL2 behind `ContainerRuntime`; Docker Desktop unused until licensed; bubblewrap/srt fallback documented, **not built** for the POC. |
| C21 | OQ Q5 (no locks, ≤3 concurrent runs), CT `concurrency` | Concurrency | RM §2.9 → one executing run per repo (execution lock + fencing epoch); tasks run one at a time in plan order. |
| C22 | OQ Q3 ("only stale work reruns") | Change handling | RM §2.12 → prefix rule (see §1). |
| C23 | DR D7 (second clarify round) | High-risk assumptions | CD §16 D7 → no second round; confirm on the approval card. |
| C24 | PA §G (jcode, Ollama, graphify cut; greenfield/estimate slides only), PA §D (multi-repo out), EX POC list | Scope | CD §13 Scope + §16 D2 → all three modes end to end, jcode + Ollama included, linked runs and the Next.js pack required; brownfield vertical slice first. |
| C25 | CD §14 (Cursor CLI), RU §1 (ACP adapter) | Adapter set | CD §18 + AD → four runners (Api, ClaudeAgent, Codex, Jcode); Cursor later; ACP not in the design. |
| C26 | CT §5 (same tool+args 3×) | Loop detection | RM §2.11 → same call + args + result 4×, same error 3×, no worktree change in N turns, no event for T min; plus GE §2.6 same signature twice skips a rung. |
| C27 | OQ POC table ("10 tasks from public OSS repos") | Eval set | CD §13 B8 → 5–10 tasks mined from Ahsan's .NET repo history. |
| C28 | WD §1 decision 3, CD §10 (profile committed under `.factory/profile/`) | Repo profile location | GE §2.10 → the repo gets the manifest only; the profile is pinned per run at `run.created` (CB §2.1). Where it is stored factory-side is not stated (leftover). |
| C29 | RU §3 (ADOPT OTel sdk-node export) | Telemetry | RM §2.14 → OTel `gen_ai.*` field names only; span export deferred. |
| C30 | CD §10a (local via Codex `--oss` or Claude Code + LiteLLM) | Local-model route | CD §14/§18, RJ → local via ApiRunner (thinking) and JcodeRunner (coding); Codex `--oss` is only a bake-off comparator. |
| C31 | WD §3 (jscpd duplication ≤3%, complexity limits), OSS/RU (reviewdog at deliver, knip) | Tools not reconfirmed by VR | Not in VR §2.7's producer list → **leftover**: treat as not in the POC unless VR adds them. |

**Genuinely undecided / open**
- Design stage runner and who writes mock files (C10); the model's role in accept (C11).
- Budget class / runner for ground (SS gives 40K only), decide-architecture, prototype, the A5 test-defect reviewer, the revise classifier; models for design, impact, decide-architecture, A5.
- Review ⟲ implement: after a blocking review, whether integrate/accept re-run and how many review loops (PA §D suggested cap 1; not carried into GE).
- Container A's restore path and network (CD §13 "registry allowlist" vs VR's feed proxy, which covers containers R/B only).
- Discover's setup-fixing agent (WD §1 step 2) is not in any v2 doc.
- Mid-run change and revise for greenfield/estimate runs; living-spec merge at deliver (CD §3a) has no owner stage.
- All [EVAL] thresholds: budgets, caps, stall N/T, cluster size 5, dependency age 30 days, timeouts, local 16K; VSTest vs MTP on the eval repo (VR §5).
- Open OQ decisions: secret manager, billing mode, eval ticket rights and auditors, approvers per non-code change type, Slack/Teams, blueprint owners, drift card; partial-delivery policy flag default.
- Parallel tasks; Decider backend (rules now, Jev later, CD §10a-2); G3 bootstrap-tests and G9 perf NFRs (later, CD §15); Jira/Confluence/Figma sinks (later).

---

## 4. Open-source tools

| Tool | Use | Status | POC? |
|---|---|---|---|
| Claude Agent SDK | ClaudeAgentRunner (coding); `settingSources: []`, InstructionsLoaded check (CB §2.9) | adopt (CD §18) | yes |
| Codex SDK | CodexRunner (coding); own CODEX_HOME | adopt | yes |
| jcode SDK (`@1jehuang/jcode-sdk`) | JcodeRunner: local/cheap coding; memory/swarm/self-dev off; pinned; canary-tested | adopt, optional (RJ, CB §2.9) | yes (use gated by bake-offs) |
| `@anthropic-ai/sdk`, `openai` | ApiRunner (thinking), Anthropic/Bedrock/Vertex/OpenAI/vLLM | adopt (AD) | yes |
| Ollama / vLLM + Qwen3.6, gpt-oss | T0 local models | adopt | yes |
| Cursor CLI, ACP SDK, acpx | other agents | later / borrow only | no |
| tree-sitter (Aider-style map), ripgrep | repo map, `search`, stub signatures | adopt | yes |
| graphify | `graph_query` for >300 files | optional | no by default |
| zod 4, yaml, defu, execa, proper-lockfile | schemas, config, subprocesses, locks | adopt (RU §10, RM §2.9) | yes |
| Docker Engine CE / Podman (WSL2) | containers A, R, B1, B2, db | adopt (CD §22) | yes |
| sandbox-runtime (srt), bubblewrap | no-Docker fallback | documented | no |
| Postgres image | throwaway test DB | adopt (VR §2.5) | yes |
| Testcontainers, Docker Compose, Ryuk | E1 services | superseded (VR §2.5) | no (refused) |
| MSW, WireMock.Net | locked fakes; accept evidence logs | adopt | yes |
| xUnit + WebApplicationFactory, Vitest/Jest + Supertest, Playwright, `@axe-core/playwright` | AC harness, UI replays, a11y | adopt | yes |
| coverlet, Vitest v8 | coverage → diff coverage in TS | adopt | yes |
| gitleaks | pack redaction, per-commit and deliver scans | adopt | yes |
| OSV-Scanner, NuGet audit | dependency audit | adopt (VR §2.7) | yes |
| squawk, `dotnet-ef` | migration lint/apply | adopt | yes |
| dependency-cruiser, ArchUnitNET | architecture, only if the repo has rules | adopt | conditional |
| Stryker (JS/.NET), diff-cover, Betterleaks, Semgrep | mutation, coverage diff, secrets, SAST | dropped / off | no |
| jscpd, knip, reviewdog | duplication, unused code, PR annotations | adopt per OSS/RU; not in VR | unclear (C31) |
| Octokit, openapi-typescript + openapi-fetch | GitHub / thin Bitbucket client for deliver | adopt | yes |
| jira.js, confluence.js, Figma MCP | sinks after approval | adopt later | no |
| MCP TS SDK | front-end server (start/status/show-card) | adopt | yes |
| ExcelJS (pinned), PERT formula | estimate xlsx | adopt / borrow | yes (estimate mode) |
| create-vite, shadcn registry, react-router | design mock, prototype | adopt | yes |
| Spec Kit, OpenSpec, EARS, BMAD finding format, PR-Agent prompts, Agent OS | spec/review formats and prompts | borrow | patterns |
| PAL MCP, llm-council | second-opinion patterns | borrow; flag off (RL) | no |
| XState, OTel GenAI names, OpenHands stuck detector, vibe-kanban cleanup | state ideas, field names, stall rules, worktree cleanup | borrow | patterns |
| Inspect AI | factory eval | adopt | yes |
| Avoided | OpenHands/Open SWE/Devin platforms, PR-Agent runtime, bolt.diy, Dyad, open-lovable, claude-squad/TruffleHog/Kodus/duh (AGPL), GitNexus, Trivy, SonarAnalyzer.CSharp, NetArchTest, Temporal/DBOS/Restate, vector DBs, Backstage, coder/agentapi, container-use, Docker sbx, SheetJS npm, Vercel AI SDK, LiteLLM route | OSS "skipped"; RU; RL; CD §18 | – |

---

## 5. Local LLMs and the "own harness"

- **Split (CD §14 locked, §18; AD):** any stage that writes files or runs commands uses a wrapped coding agent in container A (ClaudeAgentRunner, CodexRunner, JcodeRunner). Every other model stage uses the factory's own thin loop (ApiRunner). It is read-only, schema-validated (≤2 re-asks), ≤8 turns, and has no write, shell or network tools. "We don't build a harness" (EX) now holds for coding only.
- **Startup checks (AD):** thinking steps may only use `api`; coding steps only an agent runner; every step needs a usable credential. A ChatGPT login works only for Codex, and Claude needs an API key, Bedrock or Vertex (CD §10a, §14).
- **Local roles (RJ; WD §4 rule 7; SS §6a):** T0 via Ollama/vLLM for intake, discover summaries, doc-claim extraction, round-trip aligner, commit/PR text and estimate leverage tags. **Never local:** clarify, sketches (RL), specify, critic, plan, author-tests, review.
- **Local coding (experiment):** jcode + local on S implement tasks, escalating on the first tool-call error (bake-off B). jcode with a hosted model is a cost candidate (bake-off C). jcode+Ollama vs Codex `--oss` is bake-off A. All three run on the .NET eval, judged by cost per accepted task.
- **Local limits (CB §2.9, §2.11):** Ollama uses the native API with explicit `num_ctx`, and `truncate`/`shift` are off, so overflow errors instead of silently dropping. Packs are capped at 16K, and a pack that doesn't fit goes to a frontier model, never a trimmed local call. WD's "≥64K context" is the model window; the 16K cap is our pack. vLLM is preferred for tool-heavy work (WD §4, RJ).
- **Policy:** `localOnly` skips the other-vendor rung of the ladder (GE §2.6). Local think stages are marked "reduced rigor" on the card (UC X2; SS §7). The local second reviewer is **off by default** (`secondOpinion: local`) and can never block (RL).
- **POC:** in are ApiRunner (Anthropic + OpenAI; the second vendor key was approved, SS §8), ClaudeAgentRunner, CodexRunner, JcodeRunner and Ollama local (CD §13 Scope, CB §2.9). Out are Cursor, ACP, the Jev Decider (rules only), the local second opinion and the bubblewrap fallback.

---

## 6. Gap decisions (Claude, 2026-09-27; owner per Ahsan's delegation)
These close the "undecided" items above. All are reversible defaults.
- **Design (C10):** split in two. `design-read` (L, LR, read-large, T3) turns the spec and any Figma frames or images into a `design` artifact: flows, screen list and REQ↔screen map. `design-mock` (A, CA, agent class) builds the React+Vite mock in a scratch folder from the derived `design` artifact only. The mock's URL goes on the approval card.
- **Accept (C11):** deterministic only; no model. CB's read-small entry for accept is removed.
- **Budgets and runners:**
  - ground: L, T3 Opus 5.5, 40K (Ahsan 2026-09-27; research-e2e-prompt-ground.md). Seeded with non-AI search hits; approval card shows "files planned but not grounded". Recall vs Sonnet measured on the eval [EVAL].
  - decide-architecture: L, LR, read-large, T3, plus human ADR sign-off.
  - prototype: A, agent class.
  - A5 test-defect check: L, LR, read-small, T3 other family.
  - revise classifier: L, LR, read-small, T3.
  - impact: D (compiler/references) plus L T2.
- **After a blocking review:** the findings become failure records for the affected tasks, then implement ⟲ task verify → integrate → accept → review again. At most one review loop; a second blocking review parks the run with a card.
- **Container A packages:** no network except the model API. It gets the per-run package folder restored by container R, mounted read-only. A new dependency must be declared in the plan (or via a re-plan); the core restores it through R after the new-dependency check. The agent can't install anything itself.
- **Discover setup-fixing agent:** out of the POC. A red baseline stops and reports.
- **jscpd, knip, reviewdog:** not in the POC. reviewdog-style PR annotations come later.
- **Repo profile storage:** `~/.factory/repos/<repoId>/profile/`, pinned per run by commit and sha.
- **Living-spec merge at deliver:** out of the POC.
- **contracts `StageName`:** add discover-read, sketches, clarifier, merge, critic, round-trip, design-read, design-mock, stub-commit, a5-check, conflict-resolve, revise-classify.
