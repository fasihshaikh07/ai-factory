# AI Factory: Lean End-to-End Workflow (draft v1, 2026-09-25)

Covers Ahsan's four problems: discovery, convention delivery, quality enforcement, model switching. Each recommendation cites its evidence file; the files hold the links and the UNVERIFIED flags.

Evidence files (all in /mnt/project-files/ai-factory/):
- **[D]** research-discovery.md
- **[Q]** research-conventions-quality.md
- **[M]** research-model-routing.md
- **[C]** research-context-engineering.md
- **[S]** research-intent-to-spec.md

**Anything marked (heuristic) is our own proposal, not measured. Calibrate it from run logs.**

---

## 0. What "lean" means here (and where I disagree)

- **Lean = few artifacts a human must read, not few checks.** A human reads three things:
  1. the onboarding card, once per repo;
  2. the spec card, only for risky runs;
  3. the PR.

  Everything else is small, machine-read data that some gate or later stage consumes. **Rule: if no gate or stage reads an artifact, we don't produce it.**
- The 3-draft spec pipeline [S] is machine work, not BMAD-style documentation. It stays, because under-asking and misreading intent are the most expensive failures.
- **Correction to core-design §5 and §6:**
  - Graphify is **not** the default for modest repos.
  - A generated AGENTS.md is **not** a default output.

  Evidence for both is in §1 and §2 below.

---

## 1. Discovery and understanding (brownfield)

### Core workflow: runs once per repo, then refreshes incrementally [D]

| # | Step | How | Output |
|---|---|---|---|
| 1 | Inventory | Deterministic: stack from manifests, file/LOC counts, list of existing docs, instruction files and CI workflows by path | inventory |
| 2 | Baseline | Commands from CI config first, then stack pack, then README. Pin toolchain (`global.json`, `.nvmrc`). Run restore → build → test on untouched HEAD. An agent may retry setup within a time/$ cap, logging every change; the client repo is never "fixed" silently | `green` / `green-with-known-failures` / `red` + known-failures list |
| 3 | Structure map | Aider-style ranked symbol map (tree-sitter, ≤2–4k tokens) + module list with one-line purposes. **graphify only above ~300 source files** or on request, as a query tool, never auto-injected | map |
| 4 | Conventions | First from existing lint/format/analyzer configs (run them, store baseline findings). Then mine what configs don't cover (naming, layout, error handling, DI, data access, test style) by counts over the whole tree **and** over files changed in the last ~50 commits. Each convention stores counts + 2 example paths. A ≥20/80 split is flagged "mixed; newer = X" | `repo-conventions.yaml`, `baseline-findings.sarif` |
| 5 | Doc claims check | Split existing docs into atomic claims (commands, paths, env vars, routes, layer rules) and verify each by running or looking it up | conformance ratio + contradicted claims |
| 6 | Tests map | Test files → modules → tested behaviours. Business rules are extracted **just in time**, only for modules a request touches, and marked `verified` only when a test pins them | tests map |
| 7 | Onboarding card | One screen for a human: stack, commands, baseline result, mixed conventions to resolve, contradicted docs | answers into `repo-profile` |
| 8 | Write-back (optional) | Propose, as a diff, a short AGENTS.md/CLAUDE.md with commands, non-standard conventions and gotchas only. Never overwrite a human-written one | PR diff |
| 9 | Refresh | Steps 1–2 and 4–6 re-run for files changed since the profile's commit | updated profile |

`repo-profile` stays ≤8–15K tokens [C][D].

### Your three sub-questions

**(a) How to get project resources from users.** Don't ask users to hand over documents up front. Auto-discover them. No agent auto-loads README, CONTRIBUTING, ADRs or OpenAPI, so discover lists them by path [D]. Then ask on the onboarding card for only three things:
1. links to external docs (Confluence space, Jira project);
2. "rules that aren't written anywhere" (free text);
3. no-go areas.

A drop folder `.factory/context/` accepts anything extra.

Why: real docs are often stale. LLMs are 21–43 points worse at spotting a stale doc when it still reads plausibly (TRACE) [D]. Every doc we collect therefore has to be checked anyway, so we collect little and verify all of it.

**(b) How to validate docs against code.** Code is the source of truth for *what is*. Docs only count for *what should be* after a human confirms them.
- Method: extract atomic claims and verify each deterministically.
- Output: a conformance ratio, **not** an LLM verdict on whole documents.
- Evidence [D]:
  - READU: 75% precision catching README bugs.
  - CASCADE: generates tests from docs to find inconsistencies.
  - ContextCov: turns AGENTS.md prose into executable checks at 82.8% extraction precision.
- A contradiction becomes a question on the onboarding card, never a silent choice.

**(c) How to extract rules, patterns and conventions.**
- **Conventions: statistical first, LLM second.** A repo's own code is enough to learn its conventions (NATURALIZE: 94% top suggestions correct) [D]. Weight recent commits, because a snapshot misses conventions that history reveals (Learning to Commit) [D]. The LLM only summarises exemplars that the counting pass selected.
- **Business rules: lazy, anchored, test-confirmed.** The best published figure is 93% precision with no recall reported, and that was human-in-the-loop [D]. So rules are candidates with a file:symbol anchor, extracted only for the modules in scope, and marked verified only when a test pins them. Sources in order:
  1. test names and assertions;
  2. validation schemas (zod, FluentValidation, DataAnnotations);
  3. guards, enums and constants;
  4. DB constraints and migrations.

### Bottlenecks
- **Repos that don't build.** Over 38% of 7,200 Java repos failed to build out of the box. The best environment-setup agents succeed only 30–86% of the time, depending on benchmark [D]. We have no .NET or Node data, so collect our own from the first client repos.
- **Missing secrets, private package feeds, databases or external services** needed to run tests.
- **Mid-migration repos** (class components next to hooks, old next to new data access). A naive majority vote picks the legacy pattern.
- **Generated or vendored code** skewing convention counts.
- **Monorepos** with a .NET API and a React SPA need one profile per package, not one per repo.

### Decisions to make
1. **Baseline `red`:** stop, or allow an "unverified mode" behind a human gate? Recommend: stop, and show what failed.
2. **graphify threshold:** ~300 files (heuristic from two practitioner reports [D]). Confirm on your own repos in the dry run.
3. **Is the profile committed to the client repo?** You already chose run artifacts on the work branch. Recommend: profile under `.factory/profile/`, also committed.
4. **Who resolves "mixed" conventions:** always a human on the onboarding card.

### What breaks a naive approach
- The repo only runs with a real `.env` and a local database.
- Existing tests are already red or flaky, so a naive gate blames the factory.
- The README says `npm test` but CI runs `pnpm test:ci`.
- The last 50 commits introduced a new pattern that only 15% of files use yet.
- An `Areas/` folder in .NET MVC, or feature folders vs layer folders in the same repo.
- Generated EF migrations or an OpenAPI client dominate the convention counts.

---

## 2. Giving the implementation agent the project's knowledge

**Pushback: a lightweight agent needs *more* scaffolding, not less.** Instruction-following collapses as rules are added, and small models collapse fastest:
- IFScale: gpt-4o-mini falls to 42% at 100 rules, while o3 holds 98% [Q].
- StyleMBPP: style adherence falls from ~0.97 at one instruction to 0.12–0.50 at six [Q].

So the knowledge must live in **the plan and the tools**, not in the agent's head.

### Mechanism [Q]
1. **Tools check what they can; prose covers only what they can't.** Existing lint and analyzer configs stay as they are. Prose conventions are limited to non-lintable intent: layering, where files go, response/error shapes, DI registration, domain naming.
2. **One small rule store:** `repo-conventions.yaml`, plus the stack pack's generic rules. Each rule has an ID, `applies_to` globs, a one-line rule, an exemplar path and an optional check.
3. **The core picks the rules, not the agent.** It matches the task's `file_scope` against rule globs and injects **≤15 rules** (heuristic) plus **1–2 exemplar file paths**, early in the context pack. Agents load path-scoped rules inconsistently: Claude does it when a matching file is read; Codex walks from the repo root and caps at 32 KiB [Q]. Native files (`.claude/rules`, `.cursor/rules`, `.github/instructions`) are exported from the same store for interactive users.
4. **The plan names the pattern.** A frontier model writes each task as a recipe: "follow `src/routes/orders.ts`; rules CONV-3, CONV-7; files X, Y". A cheaper implementer executes it. Aider's architect/editor split improves even weak models (55.6% → 60.2%) [Q].
5. **Linter in the loop.** After each edit, the formatter and a file-scoped lint run, and only *new* violations come back (≤30 lines). Specific feedback cut security issues from >40% to 13% in one study [Q]. For Claude this is a hook; for Codex and Cursor it runs between turns (VERIFY).
6. **Skills for procedures only** ("add an EF Core migration", "add a Vite route"), generated from stack packs, scoped by path. Skills are never a dump of conventions.
7. **No generated AGENTS.md by default.** LLM-generated context files cut success by 3% and raised cost by 20–23%. Developer-written ones helped by 4% but still cost more; overviews didn't help; concrete instructions were followed 1.6–2.5x more (Gloaguen et al.) [D][Q].

### Bottlenecks
- Exemplars are plausible but **not proven** for multi-step agent edits (no study found) [Q]. Measure it: log new-lint violations and review "convention" findings with and without exemplars.
- **Bad exemplars teach bad habits.** Pick exemplars only from recent files that pass lint.

### Decisions to make
1. The rule budget per task (start at 15; tune from logs).
2. Whether to export native rule files into the client repo (recommend yes, as a diff the client can decline).

### What breaks a naive approach
- Dumping all conventions into every prompt: small models drop rules.
- A rule that only lives in prose and is never checked: agents treat specs and rules as suggestions [S].
- Mid-migration repos, where the exemplar must come from the *new* pattern.
- Tasks that create a new kind of file with no exemplar. The plan must say so, and the task goes up one complexity class.

---

## 3. Quality enforcement (separate from tests)

**Pushback: quality can't come from an LLM reviewer.** On SWE-PRBench, models found only 15–31% of the issues humans flagged, and more context made them worse [Q]. Quality has to be deterministic, enforced by the core, and invisible to the agent's judgement. The LLM review covers only what tools can't: correctness, spec mismatch, error handling, security logic and reuse.

**Key idea for brownfield: gate new code only (a ratchet).** A whole-repo zero-warning gate fails on day one of a legacy repo. SonarQube's default gate and ESLint's bulk suppressions both check new code only [Q]. Discover stores `baseline-findings.sarif`; verify fails only on **new findings in changed lines**.

**Non-negotiable means:**
- the core runs the checks, not the agent;
- the agent cannot edit the checks' config (protected paths);
- escape hatches count as violations.

AI code adds `any` about 9x more than humans. Models rewrite or special-case impossible tests 54–76% of the time (ImpossibleBench) [Q].

### Gates per stage [Q]

| Stage | Gate | Blocks |
|---|---|---|
| discover | Record baseline: lint/analyzer SARIF, architecture known-violations, coverage, duplication | records only |
| spec | 10 deterministic lint checks, stability, critic, round trip [S] | yes |
| plan | Each task has file scope, exemplar, rule IDs; rules ≤ budget; no protected paths unless declared | yes (re-ask) |
| implement, per edit | Formatter + file lint, new violations only | feedback |
| verify: hygiene | No new lint, type or analyzer findings in changed lines | yes |
| verify: escape hatches | None added: `eslint-disable` without reason, `@ts-ignore`, `as any`, `#pragma warning disable`, `[SuppressMessage]`, `null!` (allowlist in policy) | yes |
| verify: config integrity | No edits to lint, ts, analyzer or test config, or suppression files, unless the plan declared them | yes |
| verify: tests | Locked tests unchanged; no new `.skip`/`.only`/`Skip=`; no deleted tests | yes |
| verify: architecture | No new boundary violations (dependency-cruiser, ArchUnitNET) | yes |
| verify: size/complexity | Changed functions within limits (heuristic: cognitive complexity ≤15, ≤80 lines); duplication in new code ≤3% | new code yes; touched legacy warns |
| verify: diff coverage | ≥80% of changed lines covered (Sonar default; policy can change it) | yes |
| verify: security | Secrets (gitleaks), dependencies (OSV), registry check for new packages | yes |
| verify: a11y (UI) | No new serious/critical axe violations on touched screens | yes |
| review (LLM) | Only listed categories; each finding cites a diff line with a confidence; the core filters | blocking categories only |
| deliver | Findings posted as PR annotations (reviewdog) | human merges |

Waivers: a human can waive a gate with a written reason, logged in the trace. The agent never can.

### Bottlenecks
- **Repos with no linter at all.** Apply the stack pack's default rules to new code only, and show them on the onboarding card.
- **Slow checks.** Run file-scoped checks per edit and the full set once per task.
- **Licences of the checking tools themselves** (eslint-plugin-sonarjs is LGPL-3.0, axe-core is MPL-2.0) [Q]. Fine as dev tools; confirm with client legal if they end up in the delivered repo.

### Decisions to make
1. Default thresholds per gate (complexity, coverage, duplication).
2. Whether diff coverage blocks by default or only per client policy. Recommend: block on features, warn on bugfixes.
3. Who may waive gates.

### What breaks a naive approach
- A whole-repo gate on a legacy repo: it's always red, so people ignore it.
- An agent that "fixes" a lint error by disabling the rule.
- A coverage gate on a repo with no test runner for UI.
- Generated files in the diff (migrations, lockfiles) tripping size and complexity gates. Exclude them via stack-pack globs.

---

## 4. Model switching

**Pushbacks:**
- **Routing saves money; it doesn't raise quality.** Tasks cheap models solve are 90–93% contained in what strong models solve [M].
- **You can't judge complexity from the request text.** Issue text predicts agent success at AUC 0.599, near chance. Patch features reach 0.861 [M]. So complexity is computed by code **after plan/impact**, from the planned scope.

### Framework [M]

**Tiers:**

| Tier | Meaning | Examples |
|---|---|---|
| T0 | local | Qwen3.6-35B-A3B, Devstral Small 2 |
| T1 | small hosted | Haiku 4.5, GPT-6 Luna |
| T2 | mid | Sonnet 5, GPT-6 Sol |
| T3 | frontier | Opus 5.5, GPT-6 Astra |
| T4 | top | Fable 5.1 |

A client's allowed-model list filters the tiers first.

**Complexity classes** (computed by code after plan):
- **S:** 1 file, ≤~30 planned LOC, no cross-module edge, tests exist.
- **L:** ≥3 files, or crosses modules, or touches a hub module, or has no tests on touched code.
- **M:** everything else.

**Risk:** the high-risk list in core-design §3b.

| Stage | S / low risk | M or high risk | L |
|---|---|---|---|
| intake, discover summaries | T0/T1 | T1 | T1 |
| clarify, specify | T2 | T3 | T3 |
| critic, round trip | T3, fresh | T3, other family | T3 |
| plan | T2 | T3 | T3/T4 |
| author-tests | T2, family ≠ implementer | T3 | T3 |
| implement | T2 (T0 trial if policy is local) | T2 → T3 | T3, high effort |
| verify | code | code | code |
| review | T3, other family | T3, other family (+2nd judge if high risk) | T3 |
| estimate | T2 task list, code math | T3 | T3 |

**Rules:**
1. **Switch only at process boundaries** (new stage, task or retry). Changing model or effort mid-session invalidates the prompt cache [M][C].
2. **Escalation restarts clean.** The stronger model gets the stage prompt + `failures.json` + verified facts, not the weaker model's transcript [M].
3. **Escalation ladder:** re-ask with the validator error → +1 effort → next tier → other vendor → human. Early triggers skip steps:
   - turns > 1.5x the stage median;
   - the same failure twice;
   - local-model tool-call parse errors.
4. **Effort:** medium by default; high for plan, critic, review and author-tests. `max` is almost never worth it: Anthropic's docs warn about the cost, and on Aider polyglot high effort cost +64% for +1.3 points [M].
5. **Independence:** a fresh process that sees the diff as input gives most of it. Models fix far more errors framed as someone else's (+23–93 points). A different family adds more, but no controlled study measures that gain for review [M].
6. **Downgrade policy:** start every stage at the table's upper choice. Downgrade one stage × class at a time, and keep it only if cost per **accepted** task falls with acceptance not worse (heuristic: ≥30 tasks). Never downgrade plan, author-tests or review on high-risk work. Re-baseline on every model release.
7. **Local models:** only T0 roles, only with ≥64K context. vLLM or SGLang are preferred over Ollama for tool-heavy work: Ollama's default context is 4K on smaller GPUs, and it has open tool-call bugs [M]. Strict local-only clients: expect implement to work on S tasks only.
8. **Log every decision** (tier, effort, features, outcome, cost, cache share). This becomes the Decider's data (Jev or rules).

### Decisions to make
1. The tier mapping for each client's allowed list.
2. Whether the default for T2 vs T3 on implement is settled by a small bake-off before launch. Recommend yes: Opus 5.5 costs 2x Sonnet 5 per token but may take fewer steps [M].

### What breaks a naive approach
- Routing on the request text.
- Continuing a failed cheap-model transcript on an expensive model.
- A reviewer from the same session as the implementer.
- A local model with a default 4K context silently truncating.
- Per-token price used as the cost measure.

---

## 5. End-to-end run (brownfield, low-risk ticket), in one view

```
factory run --ticket ACME-123
 1 profile fresh?            → incremental refresh (§1)
 2 intake                    → intent spans, change class, rigor level
 3 ground + clarify          → questions only if above threshold (async)
 4 specify ×3 → lint → critic → round trip        [S]
 5 design (if UI)            → flow + React mock, REQ↔screen check
 6 impact + plan             → tasks with file scope, exemplar, rule IDs,
                               complexity class computed → tiers chosen (§4)
 7 gate: auto-proceed if green + low risk + internal; else spec card
 8 author-tests (fresh, other family) → must fail on HEAD → locked
 9 implement per task (fresh process each; lint in loop)
10 verify (§3 gates) ⟲ implement (ladder)
11 review (fresh, other family) ⟲ implement
12 deliver: PR + annotations + trace; spec deltas merged; human merges
```

---

## 6. Questions you haven't asked yet (and should)

1. **How does the factory run the client's app?** Env vars, secrets, database, seed data, external APIs. This is the most common practical blocker [D]. Who provides a test `.env`, and where is it stored?
2. **What's the factory's own eval set?** Without 15–30 real past tickets with known-good diffs per stack, you can't tell whether a change to prompts, routing or gates made things better or worse. Model downgrades [M] depend on it. Build it before tuning anything.
3. **What happens when a requirement changes mid-run?** Spec delta → which locked tests get unlocked (needs a human) → re-plan only the affected tasks.
4. **Partial success:** 3 of 5 tasks pass. Ship a partial PR, or hold it? Resume from the failed stage, or restart?
5. **Two runs on one repo:** a lock per module, or conflict detection at plan time?
6. **Cost ceiling per run and per client**, and who pays (the client's API key).
7. **Client consent and data:** does the contract allow AI on this code? Event logs and artifacts contain client code. What's the retention period?
8. **Non-code changes:** DB migrations, config, CI files, infrastructure. They're high-risk by default, but who approves them?
9. **Drift:** humans commit outside the factory. The profile refresh handles code, but who re-confirms conventions quarterly?
10. **Onboarding time target:** e.g. a new repo reaching its first run in under 30 minutes. That target decides how much of §1 is automatic vs asked.
11. **What does the developer see while a run is going?** Progress, cost so far, and the ability to stop, edit or approve from the plugin.
12. **Greenfield:** which architecture decisions are fixed by your company (auth provider, ORM, UI library) vs chosen per project? That's the greenfield equivalent of conventions.
