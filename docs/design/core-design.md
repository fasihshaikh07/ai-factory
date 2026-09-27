# AI Factory: Core Design (draft v1, 2026-09-24)

Scope: the core only. No schedule, team or award talk. Items marked VERIFY are assumptions not yet checked.

## 1. Principles

1. ~~The core never calls a model.~~ **Superseded 2026-09-25 by the hybrid harness (§14):** think-only stages run in our own thin loop; stages that write files or run commands run in a wrapped agent (Claude Code, Codex, Cursor, jcode).
2. **Control lives in deterministic code, not prompts.** Stage order, schemas, gates, test locks and delivery are enforced by the core. Prompts only describe how to do a stage.
3. **Every artifact is a file, schema-validated and hashed.** The trace is the set of files plus an append-only event log. Nothing lives only in a chat transcript.
4. **Agents are replaceable workers.** An agent adapter is a thin command wrapper. Swapping agents never changes stages, schemas or gates.
5. **Nothing leaves without passing gates.** An interactive agent can always edit files; the core can't stop that. What the core *can* guarantee is that unverified work never gets delivered. That is the real guardrail.
6. **Untrusted input stays data.** Issue text, briefs and repo content never become instructions to a stage that holds credentials.

## 2. Domain model

| Entity | What it is | Key fields |
|---|---|---|
| Request | The raw input: issue, change request, client brief | id, source, text (untrusted), attachments |
| Run | One execution of a mode for a Request | id, mode, repo, branch, agent, status, current_stage, policy_ref |
| Artifact | A typed, schema-validated output of a stage | type, version, path, sha256, produced_by (stage, agent, model) |
| Gate | A rule that must hold before a stage can proceed | kind (check / human), predicate, result, approver |
| Event | Append-only log entry | ts, run, stage, action, artifact hashes, usage (tokens, time, cost if reported) |
| StackPack | Data describing one stack | detect rules, commands, test harness, conventions, scaffold cmd, review checklist |
| Policy | Per-client rules | allowed agents/models, network, protected paths, size limits, forge |

**Traceability chain (the backbone):** `REQ-n → AC-n → TEST-n → TASK-n → commit → PR`. Every artifact references IDs from the one before it. A judge, reviewer or client can walk from any requirement to the exact test and diff, and back.

## 3. Stage library

Each stage has typed inputs, typed outputs, an executor and an exit gate. **A = agent does it, D = deterministic code, H = human.**

| Stage | Exec | Output artifact | Exit gate |
|---|---|---|---|
| discover | D + A | `repo-profile` (stack, commands, module map, conventions, test coverage map, hotspots) | build and tests run on untouched repo (baseline) |
| intake | D | `intent.md` with numbered intent spans I-n, change class, rigor level | classified |
| ground (brownfield) | D + A | `current-behaviour` with file:symbol anchors | every anchor resolves |
| clarify | A (+ H only if needed) | `questions` (scored) + `answers`, or `assumptions` ASM-n | max 5 questions, one async round; skipped if none clears threshold |
| specify | A ×3 independent + merge | `spec` (EARS REQs, Given/When/Then ACs, NFRs with metrics, deltas, assumptions, links to intent spans) | 10 deterministic lint checks; stability score; critic; round-trip coverage (see §3a) |
| design (UI changes only) | A | `design`: user-flow diagram (Mermaid) + React mock screens; optional Figma sink | every UI REQ maps to a screen and back; Playwright walks UI ACs |
| impact | D + A | `impact` (files/modules touched, risk, missing tests, affected consumers) | risk ≤ policy, or human approval |
| plan | A | `plan` (tasks → REQ refs, file scope, size) | every REQ covered; tasks within size limit |
| **approve-plan** | D, then H only if needed | one-page spec card + approval record | auto-proceed when all signals green, low-risk class and internal source; otherwise one human review (see §3b) |
| author-tests | A (separate context from implementer) | `acceptance-tests` (one test per AC) | tests compile **and fail** on current code (proves they test something); then **locked** by hash |
| implement | A | commits on work branch, per task | diff within planned file scope |
| verify | D | `verification` report | build, lint, unit tests pass; locked tests unchanged (hash) and passing; size limits; secret scan; dependency audit |
| review | A (fresh context; different agent/model when available) | `review` findings | no blocking finding open |
| deliver | D | PR on Bitbucket/GitHub with trace summary | human merges; the core never merges |
| scaffold | D + A | new repo from official generator + stack-pack conventions | baseline verify passes |
| decide-architecture | A + H | `adr` (architecture decisions) | human sign-off |
| breakdown | A | `work-breakdown` (module → task, in your sheet's shape) | every REQ mapped to ≥1 task |
| estimate | A + D | `estimate` (min/max per task, AI-leverage tag, buffers, rollup, xlsx export) | buffers and rollups computed by code, never by the model |
| prototype | A | clickable React + Vite mock, screens mapped to modules | builds and runs; "mock-up" banner present |

**Loops:** verify fails → back to implement with the failure report. Review blocks → back to implement with the findings. Each loop has a retry budget from Policy; when it runs out, the run **escalates to a human** with the evidence rather than retrying forever.

### 3a. Spec pipeline (the most critical part)

Evidence and sources: research-intent-to-spec.md. Summary:
- **Models under-ask**, so ambiguity detection is its own agent, not a side job of the spec writer.
- **Ask once, early, few:** max 5 multiple-choice questions with a recommended default, in one async round. Everything else becomes a logged assumption (ASM-n) with a risk tag. High-risk assumptions block; low-risk ones take defaults on timeout.
- **Disagreement is the ambiguity signal:** 3 independent spec drafts (2 model families where allowed) are merged; a requirement appearing in fewer than 2 of 3 drafts is "unstable" and goes to the critic or becomes a question. Self-reported confidence is not used.
- **Fixed format → deterministic checks:** EARS requirements, Given/When/Then ACs, OpenSpec-style ADDED/MODIFIED/REMOVED deltas for brownfield. The core lints: every REQ has an AC, EARS pattern, vague-word lexicon, NFRs have metrics, intent-span coverage, delta anchors resolve, size budget per change class.
- **Critic** in a fresh context with a fixed rubric (conflicts, missing error/empty/permission paths, testability, scope creep, unanchored claims).
- **Round trip:** a fresh agent restates the intent from the spec alone; the core fails on dropped intent spans (coverage) or added capabilities (invention).
- **Brownfield grounding:** every claim about existing behaviour carries a file:symbol anchor the core resolves; for MODIFIED behaviour a characterisation test must pass on old code first.
- **Progressive rigor:** bugfix class = 1 draft + lint + critic; feature and client brief = full pipeline (≈5–6 extra model calls, cheap versus rework).
- The locked acceptance tests, not the prose, are the real contract. Spec deltas merge into a living spec at deliver; mid-build discoveries come back as proposed deltas through the same checks.

### 3b. Human gates (kept minimal)

| Gate | When a human is needed |
|---|---|
| clarify questions | only if a question clears the impact×uncertainty threshold (async, multiple choice) |
| approve-plan (spec + design + impact + plan, one card) | skipped when all signals are green AND change class is low-risk AND source is an internal ticket. Always for: auth, payments, personal data, migrations, public API, client briefs, estimates |
| escalation | only when retry budgets run out or the circuit breaker trips |
| PR merge | always (the core never merges) |

Result: 0–1 human touches for low-risk tickets, 1 combined review for risky work and every client brief, plus the merge. The human edits assumptions and answers on a one-page card, not prose.

### 3c. Context and model-handling rules

The full 23 rules are in research-context-engineering.md. The ones that shape the core:
- Context packs built as fixed template → stack conventions → repo-profile slice → run data (cacheable prefix). Each stage declares a token budget; the core trims by priority before invoking (never trims ACs).
- repo-profile ≤15K tokens; deeper detail pulled just in time (graphify queries, ripgrep).
- One plan task per fresh agent process; pass artifacts and a progress file, never transcripts.
- Fixed tool list per stage; read-only stages get no write tools; MCP servers attached only where configured.
- Test output filtered to failures (≈100 lines); verify→implement feedback is a compact `failures.json`.
- Required `evidence[]` (path, lines, quote) in every agent output, checked by code.
- New dependencies checked against the registry (invented package names).
- Test author and reviewer run in fresh processes, different model family where allowed, with no implementer transcript.
- Escalation order: re-ask with the validator error → higher effort → stronger model → different agent → human. Rate-limit errors back off and do not count as retries. Loop detection trips a circuit breaker.
- Route on cost per accepted task, not per-token price; start frontier, downgrade one stage at a time with evidence.
- Log per stage: tokens in/out, cache read/write, turns, wall time, estimated cost.

## 4. Modes = manifests over the same stages

```
brownfield : discover → intake → ground → clarify → specify → design* → impact → plan → [approve-plan]
             → author-tests → implement ⟲ verify ⟲ review → deliver
greenfield : intake → clarify → specify → design* → decide-architecture → [approve] → scaffold
             → (continue as brownfield from plan)
estimate   : [discover if a repo exists] → intake → clarify → specify → design* → breakdown
             → estimate → [presales approval] → prototype (design mock promoted)
(* design runs only when the change touches UI)
```

Reuse matrix (why this is one product, not three):

| Stage | Brownfield | Greenfield | Estimate |
|---|---|---|---|
| discover | ✓ | after scaffold | ✓ if repo |
| clarify, specify | ✓ | ✓ | ✓ |
| impact | ✓ | – | feeds risk into estimate |
| plan / breakdown | plan | plan | breakdown (same tasks, different output) |
| author-tests → review | ✓ | ✓ | – |
| prototype | – | – | ✓ (reuses React stack pack) |

A mode is a small file (`modes/brownfield.yaml`) listing stages and gates. A new mode later (e.g. "bugfix", "upgrade dependency") is a new manifest, not new code.

## 5. How control works across agents

Two ways the core drives an agent. Both use the same stages and gates.

- **Headless (primary):** the core runs a stage by invoking the agent CLI non-interactively with a stage prompt, the allowed context and a required output schema, then validates what comes back. Gives true role separation: the test author, implementer and reviewer are separate processes with separate contexts, and can be different agents.
  - Claude Code: `claude -p --output-format json` (VERIFY flags for tool restrictions)
  - Codex: `codex exec --json` (VERIFY)
  - Cursor: `cursor-agent` CLI (VERIFY maturity)
- **Interactive (front end):** a thin plugin per agent (Claude Code plugin, Codex skills + AGENTS.md, Cursor rules) exposes `/factory start|status|approve`. It calls the core over MCP. The human uses their normal agent; the core still owns state and gates.

**Adapter contract** (all an agent adapter must implement):
```
run(stage_prompt, workdir, context_files[], allowed_tools, output_schema, limits)
  -> { output, exit_status, usage? }
```

**Where enforcement actually happens:**
1. `submit(stage, artifact)` rejects anything that fails schema or gate.
2. Work runs in a git worktree per run; the core owns the branch.
3. A git pre-push hook plus `factory verify` blocks unverified pushes.
4. Delivery happens only through the core's forge adapter, and the PR carries the verification report.
5. Forge branch protection (Bitbucket/GitHub) as the final backstop.

## 6. Context system

- `repo-profile` is built once per repo and refreshed incrementally. It holds stack, commands, module map (tree-sitter symbols), conventions and the test coverage map.
- Each stage gets a **context pack**, not the whole repo: the spec, the relevant part of the profile, and the files the plan scoped. That cuts tokens and cost.
- ~~Generated `AGENTS.md`~~ Superseded (2026-09-25, workflow-design.md §2): no generated AGENTS.md by default; at most a short proposed diff with commands, non-standard conventions and gotchas. Rules are injected per task by the core.
- No vector database in the core for v1. Repo map + ripgrep + the agent's own tools cover typical client repos. Evidence: Sourcegraph found plain search degrades around 400k lines of code (see landscape.md). Client repo sizes are an assumption to check.

### 6a. Code intelligence: graphify (decision draft)

**Update 2026-09-25 (workflow-design.md §1):** default is an Aider-style ranked tree-sitter map (≤2–4k tokens) plus agent grep; graphify only above ~300 source files or on request, as a query tool, never auto-injected.


- **Adopt graphify as an external tool behind a `CodeIntel` interface**, not embedded or forked. https://github.com/Graphify-Labs/graphify — MIT/Apache-2.0, Python, active; star count varies by source (85k–121k, UNVERIFIED).
- Use: `graphify` CLI during discover → `graph.json` + `GRAPH_REPORT.md` feed `repo-profile` (module clusters, god nodes, doc↔code links). Its MCP server (`query_graph`, `get_node`, `shortest_path`) is given to agents as a read tool in specify/impact/plan. `graphify update` keeps it incremental.
- Code parsing is local tree-sitter (no LLM) → compliant. **Docs/PDF/image extraction calls an LLM** → off by default; allowed only by client policy.
- Don't use its `graphify <agent> install` (writes always-on config into the client repo, competing with our AGENTS.md/plugins).
- Limitation: tree-sitter is syntax-level; call edges marked INFERRED are resolved by name, so DI in .NET, Express routes registered by string, dynamic dispatch and React prop flows can be wrong or missing. Impact stage treats EXTRACTED edges as evidence and INFERRED as hints; precise "what breaks" comes from the compiler/language server (tsc, dotnet build, LSP find-references) and from tests.
- Estimate reuse: god nodes and high-coupling modules → lower AI-leverage tag, wider range.
- Swappable alternatives: CodeGraph (MIT), Serena (LSP-based; check GPL on the app), SCIP indexers. Avoid GitNexus (PolyForm Noncommercial).

## 7. Stack packs (data, not code)

| Field | Node + Express + TS | React + TS + Vite | .NET |
|---|---|---|---|
| detect | package.json with express | package.json with vite + react | *.csproj / *.sln |
| build / test / lint | npm scripts | npm scripts | dotnet build / test, dotnet format |
| acceptance harness | Jest/Vitest + Supertest | Vitest + Playwright | xUnit + WebApplicationFactory |
| scaffold | npm init + template files | `npm create vite` | `dotnet new webapi` |
| review checklist | stack-specific rules | stack-specific rules | stack-specific rules |

"Specialized skills per framework" = skills generated from these packs, plus the repo's own conventions from discover. Adding a stack means adding a pack.

## 8. Estimate engine

- Output mirrors your sheet: discipline tabs → module → task → min / max / comments, 15–35% bug-fix buffer, summary rollup, cost at configured rates.
- Each task gets an **AI-leverage tag** (high: CRUD, forms, auth scaffolding; medium: integrations; low: domain logic such as scoring engines, compliance). The AI-adjusted hours sit next to the human baseline, never replacing it. Leverage factors are labelled assumptions until real data exists.
- Non-engineering disciplines (PM, PDM, QA, design) come from ratios in past sheets, labelled as ratios.
- The model proposes tasks and ranges. **Code** computes buffers, rollups and cost, so arithmetic is never hallucinated.
- Calibration loop: every factory build logs actual effort per task, which replaces the assumed factors over time.

## 9. Governance and security

- **Policy file per client:** allowed agents, allowed models, network egress, protected paths (tests, CI config, migrations, secrets), max diff size, retry budgets, forge target.
- **Credentials:** forge tokens are only used by the deliver stage (deterministic). Agent stages never see them.
- **Prompt injection:** request text is passed as quoted data; stages that read it have no forge credentials and no network beyond policy.
- **Protected paths:** a locked test or protected file changing fails verify, regardless of who changed it.
- **Audit:** `events.jsonl` per run, with artifact hashes and reported usage; replayable by re-reading artifacts in order.

## 10. Storage and layout

```
<target-repo>/.factory/
  profile/repo-profile.json
  runs/<run-id>/
    request.md  spec.yaml  impact.md  plan.yaml
    acceptance-tests.lock   verification.json  review.md
    events.jsonl
~/.factory/
  config.yaml   policies/<client>.yaml   stackpacks/   modes/
```
State is files plus the event log; a run resumes by reading them. No workflow engine or database in v1.

## 10a. Models, local models and credentials

- Adapters run the agent's own CLI/SDK. **The factory stores no model credentials**; it resolves credential *references* from the client's policy (env var, keychain, CI secret).
- **Claude constraint (verified 2026-09-24, Agent SDK docs):** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK." → Claude stages authenticate with an Anthropic API key, Amazon Bedrock or Google Vertex (the client's own cloud account suits compliance), not subscription logins. Codex/Cursor subscription terms for automated use: VERIFY.
- Adapter implementation: ADOPT `@anthropic-ai/claude-agent-sdk` and `@openai/codex-sdk` (both support schema-constrained output); Cursor via `agent -p` or ACP. See reuse.md.
- Local models run through the agent: Codex with Ollama, Claude Code via a compatible endpoint (e.g. LiteLLM), or OpenCode/goose adapters (all VERIFY against current versions).
- Model and agent are chosen **per stage** in project config. Default: local for discover and summaries; the approved frontier agent for implement and review. Local-only is a policy option for strict clients.

## 10a-2. Decider (routing and calibrated decisions)

Interface: `decide(question, options, features) -> { choice, probabilities, backend }`.
Backends: **rules** (default, deterministic), **Jev** (TypeSafe AI System One model, hosted, launched Sep 2026), **LLM with structured output**.

- Decision points: agent/model per stage, task complexity, impact risk class, AI-leverage tag, retry vs escalate, review finding blocking or not.
- Never delegated to a Decider: merge, publish to sinks, plan approval.
- Jev receives **derived features only** (task type, diff size, files touched, stack, retry count), never raw client code, because it is hosted-only with unstated data retention. Allowed per client policy.
- Below a confidence threshold → escalate (stronger backend or human).
- Every decision and its outcome is logged, which lets us measure calibration ourselves (vendor calibration claims are unverified; see critique links in thread).
- Start on rules; switch decision points to Jev once run history exists.
- Agent switching: per-stage agent in config; artifacts are files, so hand-off between agents is stateless. Retry budget exhausted → escalate to next agent in the stage's list.

Token cost note: the core parses only the agent's final JSON; agent CLI noise stays inside the agent's own context. Reduce it with context packs, failures-only test output and repo-profile reuse.

## 10b. Integrations: sources, tools, sinks

| Role | Examples | Who calls it | Access |
|---|---|---|---|
| Source | Jira issue, Figma frame, Confluence page | Core, at run start | read |
| Tool | Jira/Figma/Confluence MCP servers | Agent, only in stages listed in config | read-only by default |
| Sink | spec → Confluence/markdown, plan → Jira tasks, code → Bitbucket/GitHub PR | **Core, deterministically, after a human gate** | write |

Why sinks aren't agent tools: publishing is outward-facing and hard to undo. The core publishes exactly the approved artifact (hash-checked) with no model in the loop, so a wrong or prompt-injected run can't write to a client's systems. The core can use an MCP server as the transport (it acts as an MCP client) or the REST API directly.

Figma: the official MCP server can now write to the canvas (`use_figma`, needs a Full seat) and capture a running UI into frames (`generate_figma_design`). React mock stays the primary wireframe; Figma is an optional sink after approval (limits VERIFY).

## 10c. Multi-project configuration

Layers, top to bottom: **org defaults → client policy → project → run overrides.** Security settings (allowed agents/models, protected paths, egress, write sinks) can only get stricter going down. Credentials are references (`env:`, keychain, CI secret), never values.

```yaml
# factory.project.yaml
project: acme-portal
client_policy: acme
stacks: [node-express, react-vite]
agents: { default: claude-code, review: codex, discover: ollama/qwen }
sources: { jira: { mcp: atlassian, project: ACME } }
tools:   { implement: [], specify: [jira.read, figma.read] }
sinks:
  spec:  { confluence: { space: ACME, after: approve-plan } }
  tasks: { jira: { project: ACME, after: approve-plan } }
  code:  { forge: bitbucket, repo: acme/portal, auth: env:BB_TOKEN }
gates:   { approve-plan: [ahsan], pr-merge: human }
estimate: { rates: [30, 28, 25], bug_buffer: [0.15, 0.35] }
```

## 11. Core component list

| Component | Build or integrate | Why |
|---|---|---|
| Run state machine + gate engine | Build | This is the product |
| Artifact schemas (spec, plan, impact, estimate, …) | Build | Defines the traceability chain |
| Agent adapters (Claude Code, Codex, Cursor) | Build thin | Wrappers over existing CLIs |
| MCP server + agent plugins | Build thin | Interactive front ends |
| Stack packs | Build (data) | Encodes stack knowledge |
| Verify runner | Build, calling existing tools | Orchestrates build/test/lint/scan |
| Repo map | Integrate (tree-sitter) | Solved problem |
| Secret scan, dependency audit | Integrate (gitleaks, npm audit / dotnet list package --vulnerable) | Solved problems |
| Forge adapters (Bitbucket, GitHub) | Build thin over REST APIs | Small, configurable |
| Estimate xlsx export | Integrate (exceljs or similar) | Solved problem |
| Workflow engine, vector DB, web UI, own agent loop | Avoid in v1 | Not needed; adds lock-in and time |

## 12. Top risks

1. **Agent CLI drift.** Headless flags and output formats change. Mitigation: adapters are small and versioned; adapter conformance tests.
2. **Acceptance tests for UI are flaky** (Playwright). Mitigation: prefer API-level ACs; UI tests only for critical paths.
3. **Tests that "fail on current code" can fail for the wrong reason** (compile error, not missing behaviour). Mitigation: check the failure is an assertion failure.
4. **Brownfield repos with no working tests or build.** discover's baseline gate catches it; the run stops and says so instead of pretending.
5. **Estimate credibility.** Leverage factors are guesses until calibrated; the output must say so.
6. **Headless use under subscriptions** (terms and rate limits for Claude Code / Codex / Cursor subscriptions in automated use). VERIFY per vendor.

---

## 13. Accepted audit fixes (Ahsan, 2026-09-25; details in plan-audit.md)

These override earlier sections where they conflict.

**A1. Evidence ledger outside the agent's reach.**
- The authoritative ledger (artifact hashes, lock hashes, approvals, events) lives at `~/.factory/ledger/<runId>/`, outside the worktree.
- `.factory/**` is a protected path: the agent sandbox mounts it read-only, and verify fails on any change the core didn't write.
- At deliver, the core copies the ledger into the branch and writes `evidence-manifest.json`: the sha256 of every artifact, the config fingerprint and the tool and agent versions.
- The merge gate reads the manifest, never a transcript.

**A2. Human approvals are provably human.**
- Approvals only go through `factory approve` on a TTY, run outside the agent sandbox and process tree.
- The ledger records the OS user and the git identity.
- The approver types the one-line risk note themselves.
- Later: signed approvals via SSO.

**A3. The test-first rule depends on the change class.**
- Acceptance tests are black-box at the public surface: WebApplicationFactory/HttpClient for .NET, Supertest for Express, Playwright for UI. There are no unit-level acceptance tests; unit tests belong to the implementer and are gated by diff coverage.

| Change class | Gate before implement |
|---|---|
| feature | AC tests fail on base with an assertion failure |
| bugfix | repro test fails on base for the reported reason |
| refactor / upgrade | characterization tests pass on base (and must pass after) |
| migration | applies on an empty and a seeded DB; destructive changes split or waived |
| style-only UI | `manual` AC: screenshot evidence + human accept |

**A4. Characterization tests pin what must NOT change.**
- They target neighbouring behaviour: impact `touched` files and `missingTests`, excluding the requirements being MODIFIED or REMOVED.
- They are written before implement, must pass on base and after, and are locked like the acceptance tests.

**A5. Escalation for a defective test.**
- When the same locked test fails on 2 attempts, a fresh reviewer compares the test against its AC and returns "test wrong" or "code wrong".
- "Test wrong" raises a human unlock card showing the AC and the test side by side.
- The approval card shows the test names under each AC.

**E. New stage: accept (UAT evidence).** Runs after integrate.
- Boot the app in the E1 environment and replay each AC's locked test with HTTP recording on.
- Save one evidence artifact per AC: request/response, DB rows where the AC names data, and a Playwright screenshot for UI ACs.
- Gate: an AC with no evidence artifact is unmet.

**F. Approach options in plan.**
- The plan carries ≥2 approach options (one of them the simplest that works) and a 5-line ADR for the chosen one.
- A plan with one option fails its gate.
- UI design (the mock) stays a separate stage for UI changes.

**Resolved contradictions (audit §B):**
- B3: routing before plan uses change class + risk only; S/M/L applies from author-tests on.
- B4, B5, B6: risk is `low | medium | high`. Effective risk = max(deterministic path/keyword rules, intake model, impact blast radius). A model can raise risk but never lower it.
- B7: the loop is per task (scoped verify), then one **integrate** (full suite + all locked + characterization tests), then **accept**, then one **review** of the whole diff.
- B8: the eval set is 5–10 tasks mined from Ahsan's .NET repo history.
- Execution: the core runs restore before each agent step. New dependencies are declared in the plan and installed by the core. Agent network is `none` or a registry-only allowlist. The agent runs build, lint and unit tests; the core runs the DB-backed tests.

**Updated brownfield pipeline:**
discover → intake → ground → clarify → specify → design* → impact → plan (+options) → [approve] → author-tests + characterization (locked) → per task: implement ⟲ verify → integrate → accept → review → deliver

**Scope (Ahsan, 2026-09-25):**
- All three modes end to end; jcode + Ollama local models included.
- Adapters are vendor-neutral, and the credential route is the user's choice per vendor (Claude: API key/Bedrock/Vertex; OpenAI: API key or ChatGPT login via Codex, VERIFY terms; local: Ollama/vLLM).
- Build order: brownfield vertical slice first, then greenfield and estimate on the same core.
- Hybrid harness: LOCKED 2026-09-25, see §14.

## 14. Hybrid harness (LOCKED by Ahsan, 2026-09-25)

**Rule:** a stage that writes files or runs commands runs in a **wrapped agent**. Every other stage runs in the **factory's own thin loop**.

| Stage | Runner | Tools |
|---|---|---|
| intake, clarify, specify ×3, critic, round-trip, plan (+options), impact summary, breakdown/estimate, review, commit/PR text, discover summaries | own loop | read-only: `read_file`, `search` (ripgrep), `repo_map`, `graph_query` (if graphify), stage-specific MCP reads |
| author-tests, characterization, implement, design mock, prototype, scaffold | wrapped agent (Claude Agent SDK, Codex SDK, Cursor CLI, jcode SDK) | agent's own edit/shell tools, sandboxed worktree |
| verify, integrate, accept, deliver, all gates | deterministic code | none |

**The own loop (`LlmRunner`):**
- One provider-neutral interface over: Anthropic API/Bedrock/Vertex, OpenAI API, and any OpenAI-compatible endpoint (Ollama, vLLM, LM Studio).
- Candidate library: Vercel AI SDK (multi-provider, schema-constrained output). VERIFY current Ollama provider and tool-call support before adopting; fallback is thin direct clients.
- Output is always schema-validated (zod → JSON Schema), with ≤2 corrective re-asks carrying the validator error, then the escalation ladder.
- Hard caps are set in code: max turns (≤8 for read-only stages), max input tokens (the stage budget), wall clock.
- There are **never** write or shell tools. If a stage needs one, it moves to a wrapped agent.
- Same Usage/Event logging as the adapters.

**Credential routes (LLM-agnostic, user's choice per stage):**

| Route | Own loop | Wrapped agents |
|---|---|---|
| Anthropic API key / Bedrock / Vertex | yes | Claude Agent SDK |
| OpenAI API key | yes | Codex SDK |
| ChatGPT subscription login | **no** | Codex only (VERIFY terms for automated use) |
| Cursor subscription | **no** | Cursor CLI only |
| Local (Ollama/vLLM) | yes | jcode (or Codex --oss) |

So a subscription-only user needs an API key or a local model for the think stages. Config validation fails early if a stage has no usable route.

**What this changes:**
- Principle 1 is superseded. Compliance note: code excerpts now go to model APIs directly under API/cloud terms (POC: fine; production: covered in the AI-use addendum, Q7).
- The earlier decision "wrap agents, don't build a harness" still holds for **coding**: our loop is not a coding harness.
- Decider LLM/Jev backends run through `LlmRunner`, so they are logged and policy-checked like any stage.
- To verify in a bake-off on the .NET eval: spec stages in our own loop vs the same model inside Claude Code, compared on cost and spec lint/critic pass rate. The HarnessTax evidence is from coding tasks, so this saving is inferred.

## 15. Use-case gaps G1–G12 (decided by Ahsan 2026-09-26)

**Build now:** G1 (simple: sequential linked runs, one shared spec), G2 (`factory revise` CLI first), G5, G6, G7, G8, G11, G12 (Ahsan is on Windows). **Minimal:** G4 (size check suggests a split, human approves; auto-chaining later), G10 (static zip, no hosted preview). **Later, with seams:** G3, G9.

Windows notes for G12:
- The core is plain Node/TypeScript and cross-platform: use path.join, never hardcode `/`.
- Sandbox and Testcontainers run in WSL2.
- Docker Desktop is free only under 250 employees AND $10M revenue, so check Folio3's licence or use Podman/Rancher Desktop.
- jcode on Windows: VERIFY (native or via WSL2).
- Ollama runs natively on Windows.

Original proposal:

Full catalogue and designs: use-cases.md. Summary:
- G1: linked runs for multi-repo and full-stack work (contract first).
- G2: `factory revise` for PR comments and CI failures.
- G3: bootstrap-tests run.
- G4: run sequences for epics, greenfield and estimate hand-off.
- G5: context redaction before any model call.
- G6: locked fakes for new integrations.
- G7: rejection loop.
- G8: "cannot reproduce" outcome.
- G9: performance NFR checks.
- G10: MVP preview bundle.
- G11: Next.js stack pack.
- G12: WSL2 support.

## 16. Dry-run fixes D1–D9 (accepted by Ahsan, 2026-09-26; source: dry-run-shop.md)

- **D1. Acceptance surface = entry point + inputs + observable outputs.** It amends A3. The surface covers:
  - HTTP endpoints;
  - job and queue entry points (the stack pack declares the patterns: .NET hosted services, Hangfire/Quartz, Node workers);
  - outbound calls recorded by fakes;
  - DB rows.

  Tests stay black-box: they never reference types that don't exist yet.
- **D2. Linked runs (G1) and the Next.js stack pack (G11) are required, not optional.** The backend run locks the API contract; the frontend run starts from it.
- **D3. Literal identifiers in requirements** (client names, IDs, codes) raise a "constant or config?" clarify candidate or assumption. It's a critic item, not a blocking lint, so tickets that legitimately mention IDs aren't blocked.
- **D4. Critic rubric adds "state transitions and existing data":** what happens to existing records when a rule or setting changes.
- **D5. Blast-radius rule in impact:** any requirement that changes behaviour outside the scope the request names sets risk to high, and is shown first on the approval card.
- **D6. `environment.yaml` gains `identities`:** test users/tokens per role, created by the core in the throwaway DB.
- **D7. High-risk assumptions are confirmed on the approval card.** No second clarify round.
- **D8. External systems (payment, email, CRM, ...) are always faked in tests.**
  - Discover looks for existing test doubles first.
  - If there are none, author-tests writes them and they are locked (G6).
  - Real systems are never called by tests.
- **D9. The developer's local DB is used read-only by the core in discover** (schema, sample shapes). Tests run on throwaway Testcontainers Postgres built from the repo's migrations. Migrations are linted with squawk.

## 17. Classify by the change, not the ticket label (2026-09-26)

A ticket's source label (Jira "Bug", "Story") is only a hint. The change class, rigor and budget cap come from what the change touches: new UI, new settings, permissions, migrations, and behaviour outside the named scope. The effective class is the max of the label and those signals. For example, a "bug" that adds a setting, a role rule and a migration runs at feature rigor with the matching cap.

## 18. Adapter layer (2026-09-26)

Full design and explainer: adapters.md. One `Runner` interface with four runners:
- **ApiRunner:** `@anthropic-ai/sdk` + `openai`, which covers OpenAI, Ollama, vLLM and LM Studio. Used for thinking steps.
- **ClaudeAgentRunner**, **CodexRunner**, **JcodeRunner:** used for coding steps.

Safety is enforced by the core around every runner: secret scan, timer and cost cap, JSON validation, diff scope and test locks. The adapters only translate. A new vendor means one adapter plus the 5-job conformance test.

This supersedes the "Vercel AI SDK candidate" note in §14.

## 19. Gate engine (2026-09-26; v2 after a fresh-context review, owned by Claude per Ahsan)

Full design: gate-engine.md.
- Gates are pure code functions over ledger copies of artifacts. There are ~35 checks and 3 human gate types.
- On failure: retry (fresh process, failures.json) → escalate → park.
- Waivers: named human + reason. Never waivable: locks, secrets, protected paths, manifest integrity.
- `factory verify-evidence` re-runs every code gate on the stored artifacts.

**v2 changes** (gate-engine.md §6):
- A sealed producer container runs all builds, tests and scans (no ledger mount); predicates are pure.
- Wider lock set, plus a check that every expected locked test ID executed.
- Tests run on base by the core, twice.
- Hash-bound approvals, waivers and unlocks; the gated tree SHA is the pushed SHA; the manifest hash is posted via the forge.
- No new failures vs baseline; flaky tests are re-run once and flagged.
- One failure ladder with global caps.
- Per-field stricter-only merge.
- One ledger: the repo-side events.jsonl is dropped and the manifest is committed at deliver. This supersedes §10's events.jsonl in the repo.

## 20. Run manager (2026-09-26; v2 after a fresh-context review, owned by Claude per Ahsan)

Full design: run-manager.md. Evidence: research-run-manager.md.
- Ledger `~/.factory/ledger/<runId>/`: append-only `events.jsonl` (fsync per append; torn tail truncated) plus content-addressed artifacts. State = replay; no database, no XState snapshots.
- A step is skipped on resume only if a completed event matches its inputsHash. Coding steps: stop container → hardened commit → treeSha → completed. Interrupted coding steps save their diff, reset to taskStartSha, and retry fresh with the diff as an overlay.
- Sinks: intent → look up before create → done.
- Human waits persist a card and exit. Decisions are TTY-only (never MCP), hash-checked under a per-run ledger lock. An execution lock per repo with a fencing epoch; one executing run per repo.
- Host git disables hooks, fsmonitor and filter drivers; container A gets no git metadata. Rebase before integrate. Deliver adds one manifest-only commit on top of the gated SHA (amends gate-engine §2.3).
- `delivered` is not terminal: revise/steer until the PR merges or closes. Rejection goes through the change path.
- WSL2-only on Windows; `/mnt/<drive>` refused. Containers labelled and reconciled only for runs with a free lock.
- Supersedes §10 (layout, events.jsonl in the repo) and contracts §1 RunState and §4 Event.

## 21. Context builder (2026-09-26; v2 after a fresh-context review, owned by Claude per Ahsan)

Full design: context-builder.md. Evidence: research-context-builder.md.
- Drives cost and noise, not correctness (gates do that). Pointers, not dumps: ≤10 paths with reasons; ≤15 matched rules; recap of hard constraints at the end.
- Pack = stable SYSTEM (template → stack-pack rules → pinned profile slice) + per-call USER (rules → artifacts → untrusted docs → pointers → task → recap). Built once per step, stored redacted in the ledger, reused by packSha on resume/retry.
- **Locked room:** untrusted text (tickets, docs, PR comments, repo agent files, images) is read only by steps with no write/shell/network/model-driven MCP. Their repo tools are rooted at a tracked-files snapshot with secret excludes and scanning. External docs are fetched by the core. Building a writing step with untrusted or MCP input is a hard error.
- Revise items are confirmed on a TTY card. Discover splits into a deterministic DB step and a locked-room reading step.
- Secrets: path excludes + gitleaks; agents get an agent env template with dummy values, and real test settings go only to container B (amends run-manager).
- Plan emits interface stubs committed before author-tests (amends gate-engine: not-implemented counts as an expected failure).
- Isolation: Claude `settingSources: []` + `projectConfigRoot` + InstructionsLoaded fail-check; Codex `project_doc_max_bytes=0` + own CODEX_HOME, repo never trusted; masks in container A as a backstop; agent files in the config-integrity set. The canary test is this component's acceptance test.
- No compaction; one task per fresh process; failures.json capped; 1-hour cache for implement ⟲ verify. Ollama uses the native API, explicit num_ctx, truncate:false. Local packs ≤16K.
- Budgets in three classes (read-small 15K, read-large 30K, agent 40K), manifest overrides; all [EVAL].

## 22. Container runtime (2026-09-27, research-no-docker.md)

Folio3 has no Docker licence. Ahsan has Docker Desktop on his own laptop, but it isn't used for factory work until Folio3 confirms a licence.
- **Default:** Docker Engine CE (Apache-2.0) or Podman (Apache-2.0) inside WSL2. Both are free for any company, install with apt, and need sudo only inside the distro. The core talks to either through one `ContainerRuntime` interface using the Docker-compatible CLI.
- **Fallback (no container runtime):**
  - container A → sandbox-runtime (srt, Apache-2.0, beta), which wraps the agent process: bubblewrap plus a proxy with a domain allowlist.
  - container B → bubblewrap as a separate `factory-runner` user, with its own PID namespace.
  - Test DB → per-run embedded-postgres, or a local Postgres with template clones, under a non-superuser role.
  - Repos whose tests need Testcontainers are refused in this mode.
  - Weaker than containers: shared kernel, no TLS inspection. Needs a check on a real WSL2 laptop.
- Built-in agent sandboxes (Claude Code, Codex) are inner layers only. Claude's covers only shell commands, not its file tools, MCP servers or hooks.

## 23. Verify runner (2026-09-27; v2 after a fresh-context review, owned by Claude per Ahsan)

Full design: verify-runner.md. Evidence: research-verify-runner.md.
- The producer half of the gates: copy (git archive of the gated SHA) → restore (container R, only through a TLS-terminating feed proxy with a URL-prefix allowlist; the proxy adds private-feed credentials) → build (B1, no network) → test (B2 in the db's network namespace, loopback only). Every container is stopped before its results are read; one fresh results mount per phase.
- Caches: npm's cache is integrity-checked; NuGet shares only hash-verified `.nupkg` files and extracts per run. `bin/obj` is never reused.
- Expectations per stage (expectPass / expectFail with failureKind / compareToBaseline). Valid = report exists, every expected ID has the expected outcome, executed ≥ discovered, exit code agrees. Locked tests must pass first time; flaky re-runs apply only to non-locked tests. Infra only if a core probe fails.
- POC support: Postgres only; Testcontainers repos, other DB engines and Windows-only targets refused at onboarding. No recording proxy: evidence comes from locked fakes. OSV and new-dependency checks run on the host. Diff coverage at integrate only, computed in TS. Mutation off.
- After a rebase, new integrate failures are re-run on the new base and classed `upstream` when they fail there too.
