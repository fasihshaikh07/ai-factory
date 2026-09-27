# Context Builder v2: Simple Design + Explainer (2026-09-26)

Purpose: decide exactly what every model call sees, keep it small and cheap to cache, keep injected instructions and secrets away from anything that can act, and record it so any run can be audited. Owned by Claude (Ahsan, 2026-09-26). v2 applies an independent fresh-context review (16 findings; §6).
Evidence: research-context-builder.md (this component), research-context-engineering.md (rules R1–R23), research-conventions-quality.md, research-discovery.md. Tags: **[docs]**, **[source]**, **[paper]**, **[preprint]**, **[practitioner]**, **UNVERIFIED** (read from abstract/summary only), **[EVAL]** = our estimate, measure when built.

**What this component is not.** It mostly drives **cost and noise**, not correctness. The same model in a different harness moved accuracy about 2–5% but cost up to 5× (HarnessTax, 30 tasks; research-benchmarks.md). Correctness comes from the gate engine. In coding steps the agent decides what else to read; we control the starting pack, the rules, the tools and what's physically in its workspace.

---

## Part 1. The idea in plain words

**Analogy: briefing a contractor.** You don't hand a contractor the whole building archive. You hand them a one-page work order, the drawings that matter, the house rules for this floor, and the rooms to start in. They fetch anything else themselves. Letters from strangers (tickets, emails, review comments) are read by a clerk in a locked room first, who turns them into a clean work order; the contractor never gets the raw letter.

Six rules:
1. **Pointers, not dumps.** Give paths with a one-line reason ("start here, verify"); the agent reads files itself. In the SWE-bench paper, pasting more retrieved files *lowered* a model's resolve rate (Claude 2 with BM25: 1.96% → 1.22% as context grew 13K → 50K), while the exactly right files raised it (4.8%) [paper]. Soft file hints raised an agent's resolve rate 44.7% → ~49% [preprint].
2. **Stable first, changing last.** The same fixed text leads every call so the provider's cache reuses it (cached input costs 0.05–0.1× normal) [docs].
3. **Strangers' text is quarantined.** Raw tickets, docs and PR comments are read only in a locked room: steps with no write, shell, network, model-driven connectors, or access to secrets. Coding agents get the clean artifacts made from them. Architecture beats prompt tricks: adaptive attacks broke 12 published prompt defences at >90% success [preprint]; restricting tools before untrusted text is read cut attack success 47.7% → 7.5% [paper].
4. **Measured, never silently cut.** Every pack is counted before the call. Over budget → trim two optional parts → still over → the step stops with a clear reason. Nothing is truncated without a record.
5. **Nothing sneaks in.** The client repo's own agent files (CLAUDE.md, AGENTS.md, `.claude/`, `.mcp.json`, `.codex/` …) never load automatically. Without isolation, `claude -p` runs the repo's `.claude/settings.json` hooks and connects its `.mcp.json` servers with no prompt [docs].
6. **Every pack is recorded.** The exact (redacted) pack goes into the ledger; a resumed step reuses it byte for byte.

---

## Part 2. The design

### 2.1 Where it sits
```
step (run manager) → buildPack(recipe, inputs, runSnapshot, model) → ContextPack → runner/adapter → model
                                         └→ ledger: pack artifact; packSha on step.started
```
- **Built once, then reused.** A pack is built when a step first starts and stored as an artifact. A resumed or retried step with the same inputsHash **loads the stored pack by packSha**; it doesn't rebuild it. (Rebuilding isn't reliably identical: vendor token counts are estimates, the repo map changes after each commit, and a fallback model changes the recipe.)
- **Run snapshot:** the repo profile, conventions and stack-pack versions are pinned at `run.created` (profileCommit + shas). Rule changes mid-run don't leak into a running run.
- Serialisation is deterministic (sorted keys, no timestamps or IDs before the run-specific block), so equal packs across runs share cache.

### 2.2 Trust levels and the locked room
| Level | What | Allowed into |
|---|---|---|
| **trusted** | factory templates, stack packs, human answers and decisions typed on the TTY, human-confirmed conventions | any step |
| **derived** | schema-validated artifacts our steps produced (intent, spec, plan, stubs, failures.json, verification); a linked run's contract, bound by its hash | any step |
| **untrusted** | raw ticket and comments, Confluence/docs, PR review comments, the repo's agent instruction files, web pages, images from outside | **locked-room steps only** |

**Locked-room steps** (intake, clarify, specify and its sub-steps, design, impact, plan, review, accept, estimate, discover's reading step) run on our own LLM loop with:
- **No write, shell or network tools, and no model-driven MCP.** External sources (Jira ticket, linked Confluence pages, Figma frames) are fetched **by the core before the call**, by ID from the ticket or config, and inlined as untrusted sections. The model can't choose what to fetch, so it can't smuggle data out through a search query.
- **Repo tools served by the core** (`read_file`, `search`, `repo_map`, `graph_query`) are rooted at a **snapshot of tracked files at the run's base commit** (`git archive` into a scratch folder), never the developer's checkout with its live `.env`. The §2.6 path excludes apply to tool calls, and every tool result is secret-scanned before the model sees it.
- **Hard rule, not config:** `buildPack` refuses any recipe that puts an untrusted section or an MCP source into a step that can write (author-tests, implement, conflict-resolve, scaffold). Project config can't override this.

**Honest limits:**
- Derived artifacts can carry injected wording through the model that wrote them (e.g. an AC saying "also add an admin endpoint"). The spec is gated (critic; plan approval for risky work), and container A has no secrets and no open network, so the worst case is bad code, which the gates and the human merge see.
- Code the agent reads (comments, test output) is untrusted too. That's contained by the sandbox and the gates, not by this component.

**Revise (G2):** PR comments are untrusted. `factory revise` runs them through a locked-room step that turns each into a structured item (failure record or AC change) with the original comment quoted. The human who ran `revise` confirms the items on a TTY card before any reaches implement.

**Discover:** split into (1) a deterministic core step that reads the local DB schema read-only (D9), with no model, and (2) a locked-room model step that reads the repo's instruction files and docs, with no DB access. Human-written CLAUDE.md/AGENTS.md content becomes candidate rules shown on the onboarding card, where the human can accept them all at once (developer-written files helped ~4% in Gloaguen et al.).

### 2.3 Pack layout
```
SYSTEM (stable, cacheable)
  1. stage template (versioned)                        trusted
  2. stack-pack rules for this stage                    trusted
  3. repo-profile slice (commands, module list, map)    derived, pinned per run
USER (per call)
  4. matched repo rules (≤15) + exemplar paths          trusted (human-confirmed)
  5. artifacts by ID (ACs, plan task, stubs, failures)  derived
  6. untrusted documents / images, wrapped              untrusted (locked room only)
  7. pointers: ≤10 paths with a one-line reason each    derived
  8. the task instruction
  9. recap: 3–6 hard constraints                        trusted
```
- **Documents before the task, recap at the end.** Anthropic says put long inputs first and the query last; OpenAI says put instructions once above the context. A short recap satisfies both [docs]. Anthropic's "up to 30%" has no published method; we don't rely on it.
- Untrusted content is wrapped `<untrusted_document id source>…</untrusted_document>` in the user message, never the system prompt; the template says it's data, never instructions.
- Rules sit early in the user message (earlier instructions are followed better) [paper, IFScale]. Rule and pointer caps (15, 10) are **[EVAL]**.
- Claude agents use `excludeDynamicSections: true`, so different worktrees share one cache entry [docs].
- **Greenfield / estimate before scaffold:** section 3 holds the stack-pack defaults and, after decide-architecture, the ADR. No repo map.

### 2.4 Recipes: three classes, per-stage overrides in the mode manifest
| Class | Steps | Default budget | Tools |
|---|---|---|---|
| **read-small** | intake, clarify, estimate, accept, discover-read | 15K | locked-room repo tools |
| **read-large** | specify drafts, merge, critic, design, impact, plan, review | 30K (merge 40K, per spec-stage.md) | locked-room repo tools + repo_map/graph |
| **agent** | author-tests, implement, conflict-resolve, scaffold | 40K | container A only |

- **One source of truth:** the budgets live in the mode manifest. spec-stage.md's table is the override for spec sub-steps; this table is the default for everything else. All numbers **[EVAL]**.
- Budgets count **our pack**. The manifest also records the **full first-request size** (agent preset + tool schemas + pack) from reported usage, since the preset and tools are large. The "~50% of the window" session cap (§2.10) uses the full size.
- **author-tests sees:** ACs, **interface stubs** from the plan (§2.8), test-harness rules, one exemplar test path. Never the plan's approach.
- **review sees:** the diff, ACs and intent spans (the "why"), the verification summary. Related files are pulled through tools. Each finding is checked against code before it counts. Detection falls as review context grows [preprint]; textual intent helped review quality much more than surrounding code (+60–78% vs +4–22% F1, UNVERIFIED) [preprint].
- **Tool hints are explicit.** Agents skipped an available graph tool in 58% of trials unless told when to use it [preprint, 1 repo]. Templates say which tool, when.

### 2.5 Assembly
```
1. resolve   recipe → content (artifacts by sha, rules by file_scope glob, pointers from the plan, core-fetched external docs)
2. check     untrusted/MCP sections only in locked-room steps, else build error
3. redact    path excludes + gitleaks on every inlined section (§2.6)
4. wrap      untrusted → tagged; artifacts → <artifact id kind sha>
5. order     layout §2.3
6. count     proxy (o200k × 1.35 for Claude [EVAL]); vendor count API when within 15% of budget or when images are present
7. trim      (a) pointer list tail, (b) repo-map depth. Nothing else is ever trimmed.
8. fit?      no → agent steps: "pack-over-budget" → failure ladder → plan splits the task.
             read steps (can't split): park with a card naming the oversized section.
9. record    pack artifact → ledger; packSha on step.started
```
- `failures.json` is capped: the first 20 distinct failure signatures plus a count of the rest [EVAL]. A build break with hundreds of errors can't blow the budget.
- Token counts differ by vendor: Claude 4.7+ produces ~30% more tokens than earlier Claude; proxies can be 10–20% off on code (UNVERIFIED) [docs, practitioner]. Anthropic `count_tokens` and OpenAI `input_tokens` are free.

### 2.6 Secrets
- **Path excludes** (never inlined, never served by locked-room tools, never copied into container A): `.env*` except `*.example`, `appsettings.*.json` except the base file, `*.pfx`, `*.pem`, `*.key`, `secrets.*`, `launchSettings.json`, `*.tfvars`, plus the project's `noGo` globs.
- **Scan:** gitleaks with network verification off, on every inlined section and tool result. Hits become stable placeholders `«SECRET_n»`. Gitleaks had the best recall of 9 tools (88%) but only 33% for a secret passed as a bare function argument [paper, preprint]; it's a backstop.
- **The real control: no live secrets where a model can act.** Two per-project templates replace the old include list for env files:
  - **agent env template** → container A: dummy values so the app compiles and unit tests run.
  - **producer env template** → container B only: the throwaway test DB connection string and similar.
  *This amends run-manager §2.5, §2.10 and Part 3, which copied `.env` into the worktree.*
- **Tracked secrets** (e.g. a dev connection string committed in `appsettings.json`): discover lists them on the onboarding card. Policy decides: accept (the vendor may see them), or refuse the repo. Tracked files are never silently rewritten.
- The ledger stores only redacted packs.

### 2.7 Long documents and images
- Under ~20K tokens [EVAL]: inline in full, wrapped.
- Over: a locked-room step picks the relevant sections by heading, then extraction outputs each requirement with a verbatim quote + doc ID, checked by code like `evidence[]`. **Never summaries:** the best model in one study extracted 15 of 44 specs from a long document and fabricated details; a two-step annotate-then-convert flow gave +29% correct specs [preprint]. Multi-doc summaries hallucinated up to 45–75% of content [paper].
- **Images** (screenshots, Figma frames, PDFs): an `image` section, core-fetched, counted with the vendor API, untrusted, locked room only. Coding agents get the design artifact derived from them.

### 2.8 Interface stubs (author-tests)
- A new API has no signature on base, so tests couldn't compile. **The plan emits stubs**: signatures only (method bodies throw `NotImplementedException` / `throw new Error("not implemented")`).
- The core commits the stubs (hardened git) before author-tests. Author-tests sees stubs + signatures of existing symbols in the task's scope (tree-sitter tag queries; works on broken builds).
- *Amends gate-engine §2.5:* on base-plus-stubs, a "not implemented" failure counts as an expected failure alongside assertion failures. The stub commit is shown in the plan card and is part of the gated history.
- Compiler-based extraction (`tsc --emitDeclarationOnly`, PublicApiGenerator) is **[EVAL]**, off in the POC.

### 2.9 Agent isolation
**Primary control: adapter settings + a hard check.**
| Adapter | Settings |
|---|---|
| Claude Agent SDK | `settingSources: []`, `projectConfigRoot` → factory folder, `systemPrompt: {preset: "claude_code", append: <SYSTEM>, excludeDynamicSections: true}`, `claudeMdExcludes: ["**"]`, auto memory off, `persistSession: false`, `DISABLE_COMPACT=1`. An `InstructionsLoaded` hook logs every instruction file; **any file not from the factory fails the step**. The docs conflict on whether `settingSources: []` alone blocks CLAUDE.md, hence the belt-and-braces [docs/source]. |
| Codex SDK | factory-owned `CODEX_HOME`, `developer_instructions` via `--config`, `project_doc_max_bytes=0`, client repos never marked trusted (a trusted repo can replace Codex's base prompt via `model_instructions_file`), auto-compaction off [source]. |
| jcode | reads only `<cwd>/AGENTS.md` and `~/AGENTS.md`, with no off switch [source]. Container A's HOME is factory-owned and the root AGENTS.md is masked, which covers both. Kept (local models are in scope); canary-tested. |
| Ollama | native `/api/chat` with explicit `num_ctx`, `truncate: false`, `shift: false`, so an oversized prompt errors instead of dropping the oldest messages silently (the default logs only at debug level; the default context is 4K on machines under 24 GiB VRAM) [source; VERIFY the flags]. `prompt_eval_count` is logged, not used to fail. |

**Backstop: masks in container A.** At worktree creation the core lists agent files at any depth, including symlinks pointing to them, and mounts empty read-only files over them:
- `CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md`, `AGENTS.override.md`, `GEMINI.md`, `.cursorrules`, `.windsurfrules`;
- `.claude/`, `.codex/`, `.cursor/`, `.mcp.json`, `.github/copilot-instructions.md`, `.github/instructions/`.

Files appearing later (e.g. inside `node_modules` after restore) are caught by the InstructionsLoaded check, not the masks.

**Agent files join the gate engine's config-integrity set** (any depth, including new files), so an agent can't ship a new `sub/AGENTS.md` in the PR. The optional export of confirmed rules into native formats (workflow-design §2) is written by the core as a separate human-approved diff, never by the agent.

**Canary test (this component's acceptance test):** a fixture repo whose every agent file, a `.claude/settings.json` hook, a `.mcp.json` server, a symlinked AGENTS.md and a `node_modules/x/CLAUDE.md` each carry a unique marker. A run through every adapter must show no marker in any transcript or tool call. Re-run on every SDK upgrade.

### 2.10 Long sessions: no compaction
- One task = one fresh process (R4). Compaction is **off**. Summarising compressors made reliably solved tasks intermittent, and Claude's compactor kept 10% of safety rules after 5 rounds (both UNVERIFIED preprints).
- A session that outgrows its cap (turns, USD, or ~50% of the effective window measured on the full request [EVAL]) fails → failure ladder → re-plan smaller.
- Must-survive rules live in the system prompt/append, never only in turn history.
- Between attempts: `failures.json` (capped), prior failure signatures, the saved diff as an optional overlay. Never a transcript (R8).
- **Cache life:** the implement ⟲ verify loop uses the 1-hour cache for Claude (a verify run can outlast 5 minutes; the 2× write cost pays back after ~2 reads) [docs]. Cache-read share ≥70% on multi-turn steps is a target **[EVAL]**.

### 2.11 Local models
- Local packs are capped at **16K** [EVAL]. Small open models fabricated 47–79% of answers at 32K on document Q&A; the median across 26 models was ~25% [preprint]. A pack that doesn't fit goes to a frontier model (Decider), never a trimmed local call.
- `num_ctx` = pack + expected output + margin, set per request.

### 2.12 Contract
```ts
interface PackRecipe {
  stage: StageName; class: "read-small" | "read-large" | "agent";
  budgetTokens: number; recapKey: string; sections: SectionSpec[];
}
interface SectionSpec {
  id: string;
  source: "template" | "stackpack" | "profile" | "rules" | "artifact" | "doc" | "image"
        | "pointers" | "feedback" | "task" | "recap";
  ref?: string;                                   // artifact kind, doc/connector id, glob…
  trust: "trusted" | "derived" | "untrusted";
  placement: "system" | "user";
  trimmable?: "pointers-tail" | "map-depth";      // everything else is never trimmed
}
interface ContextPack {
  system: string; user: string; images: Sha[];    // → AgentRequest.systemPrefix / task; LlmRequest likewise
  pointers: { path: string; reason: string }[];   // replaces contextFiles
  tools: string[];                                // fixed per stage (R6)
  manifest: {
    stage: StageName; model: string; recipeVersion: string;
    sections: { id: string; tokens: number; trimmed: boolean; trust: string }[];
    packTokens: number; budgetTokens: number; countMethod: "proxy" | "vendor";
    fullRequestTokens?: number;                   // filled from first-turn usage
    redactions: number; packSha: Sha;
  };
}
```
Supersedes contracts §3 `contextPack`/`contextFiles` wording. `AgentRequest.systemPrefix` = template + stack-pack rules + profile slice; repo conventions go in `task`.

---

## Part 3. Example: implementing TASK-2 of SHOP-412

1. The plan task says: files `Orders/OrderSync.cs`, `Orders/OrderController.cs`; follow `Customers/CustomerSync.cs`; rules CONV-3, CONV-7; ACs AC-2, AC-3. No new API, so no stubs.
2. Resolve from the run snapshot: .NET stack-pack rules + profile slice (system, same bytes as TASK-1 → cache hit), CONV-3/7 + 2 more matched by glob, AC-2/3 text, pointers (the 2 files + the exemplar, with reasons), recap ("don't edit tests; no new packages; keep the public API").
3. Redact: 0 hits. Count: 11.8K proxy, under 40K, nothing trimmed. Stored as pack `9c1e…`.
4. Claude runs in container A with the agent env template (dummy values) and the repo's CLAUDE.md masked. The InstructionsLoaded log shows only factory text.
5. Verify fails one test → attempt 2 reuses pack `9c1e…` plus `failures.json` (1 signature, 14 lines). The prefix is still in the 1-hour cache.

---

## Part 4. How to explain it

> Each AI step gets a short briefing, not the whole codebase: the task, the rules for the files it touches, and where to start looking. It fetches anything else itself. The fixed part of the briefing is the same across steps, so the provider caches it and we pay a fraction. Text from outside (tickets, documents, review comments) is read only in a locked room by steps that can't change anything, run commands or reach the internet; the coding agent gets the clean spec made from it. Secrets are filtered out, and more importantly the agent's workspace holds only dummy values. Every briefing is saved, so we can show exactly what the AI saw.

| Question | Answer |
|---|---|
| Why not give the agent everything? | In the SWE-bench study, pasting more files lowered success, while pointing at the right files raised it. It also costs more. |
| Can a malicious ticket hijack the coding agent? | The raw ticket never reaches it. Only locked-room steps read it; they can't act or reach the network. The coding agent has no real secrets, and the gates check the result. |
| Does the client's CLAUDE.md or AGENTS.md apply? | Not automatically. We read it once, turn it into rules, and a human confirms them, usually in one click. Auto-loading could also bring in the repo's hooks and servers. |
| What if the briefing is too big? | Two optional parts are trimmed; if it still doesn't fit, a coding task is split, and anything else stops with a clear message. Nothing is cut silently. |
| Can you prove what the AI saw? | Yes. Every briefing is stored, redacted, with a hash in the run's log. |

---

## 5. Evaluate when built
- **Canary test** (§2.9) on every adapter, and on each SDK upgrade.
- Budgets per class and the 16K local cap; caps of 15 rules, 10 pointers, 20 failure signatures; the 20K inline threshold; the 1.35 proxy margin.
- Pointers: correct vs wrong vs no hints (no study measures harm from wrong hints).
- Exemplars vs prose rules (no study for agentic edits).
- Recap on/off; docs-first vs docs-last on our intake/specify evals.
- Cache-read share per step; the 1-hour cache's payback.
- Proxy vs vendor token count error on our repos.
- Ollama `truncate`/`shift` flags behave as read in source.

---

## 6. Review log (fresh-context review, 2026-09-26)

| # | Sev | Finding | Decision |
|---|---|---|---|
| 1 | crit | "Read-only" steps had host `read_file` (live `.env`) plus MCP queries that leave the machine | **Fixed:** locked room: tools rooted at a tracked-files snapshot, excludes + scan on results, external docs fetched by the core, no model-driven MCP (§2.2) |
| 2 | crit | Config could give MCP to implement | **Fixed:** hard build error for untrusted/MCP in writing steps (§2.2) |
| 3 | high | Discover mixed untrusted files with a live DB | **Fixed:** split into a deterministic DB step and a locked-room reading step (§2.2) |
| 4 | high | Revise comments reached implement unreviewed | **Fixed:** structured items confirmed on a TTY card (§2.2) |
| 5 | high | Masks incomplete, fixed at start; agent could ship a new AGENTS.md | **Fixed:** adapter isolation + InstructionsLoaded check primary; wider masks incl. symlinks; agent files in the config-integrity set (§2.9) |
| 6 | high | Over-budget loop: unbounded failures; "split" meaningless for read steps | **Fixed:** failures capped; read steps park with a card (§2.5) |
| 7 | high | Determinism overclaimed | **Fixed:** store once, reuse by packSha; run snapshot; gitleaks without network verification (§2.1) |
| 8 | med | Budgets contradicted spec-stage; missing recipes | **Fixed:** three classes + manifest overrides; spec-stage wins for its sub-steps (§2.4) |
| 9 | med | Contradiction with run-manager's `.env` copy | **Fixed:** agent/producer env templates; run-manager amended (§2.6) |
| 10 | med | New APIs have no signatures for test authors | **Fixed:** plan stubs committed before author-tests; gate-engine amended (§2.8) |
| 11 | med | No images; greenfield profile; linked contract trust; human CLAUDE.md lost | **Fixed:** image sections; stack-pack/ADR slice; contract = derived by hash; one-click confirm on the card (§2.2–2.3, §2.7) |
| 12 | med | Budgets ignored the agent preset and tools | **Fixed:** full first-request size recorded; session cap uses it (§2.4) |
| 13 | med | Cache assumed a 5-minute window | **Fixed:** 1-hour cache for implement ⟲ verify; target [EVAL] (§2.10) |
| 14 | med | Ollama truncation check unreliable | **Fixed:** `truncate:false`/`shift:false` so it errors; count only logged (§2.9) |
| 15 | low | Citations overclaimed or untagged | **Fixed:** SWE-bench stated precisely; UNVERIFIED/[EVAL] tags; hooks attributed to `.claude/settings.json`; datamarking removed |
| 16 | low | contracts drift; native rule export vs masks | **Fixed:** contracts §9; core writes exports (§2.9, §2.12) |
| Simplify | | gitleaks only; tree-sitter only; no BM25; 2-step trim; no datamarking; no per-section shas; 3 recipe classes | **Adopted.** Kept LLM section-picking for long docs (a human picking sections adds a touch per ticket) |
