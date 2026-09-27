# AI Factory: Reuse Survey (what to depend on, borrow, or skip)

As of 2026-09-24. Research only; no product code. Companion to `core-design.md` (the design) and `landscape.md` (competitors; not repeated here). Code-graph tools are out of scope (covered elsewhere).

**Verdicts.** **ADOPT** = take it as a dependency. **BORROW** = copy a pattern, template or small part and credit the licence. **SKIP** = don't use it.

**Status** uses landscape.md's labels (mature / active / experimental / archived). A dated status means the date was checked first-hand.

**How dates and licences were checked.** The GitHub API and GitHub MCP were not available in this session, so I checked each project another way:
- npm packages: the npm registry (latest version, publish date, licence field).
- GitHub repos: the Go module proxy (the time of the latest tag, and of the latest commit on main/master; this works for any public repo).
- Licences: the repo's LICENSE file, read from raw.githubusercontent.com.
- NuGet and PyPI: their own registry APIs.
- Star counts are approximate, taken from GitHub pages through a web fetcher. Anything I could not confirm is marked UNVERIFIED.

**Licence flags at a glance:**
- **AGPL-3.0**: claude-squad, TruffleHog, Kodus.
- **Proprietary / commercial terms**: Claude Agent SDK (Anthropic Commercial Terms), `@cursor/sdk` (Anysphere ToS), Docker `sbx`.
- **Mixed**: Dyad (`src/pro` is under a separate licence).
- **LGPL-2.1**: Semgrep engine. Its rules are under a separate, non-OSI licence (VERIFY).
- **ELv2**: Arize Phoenix (see landscape).
- **SheetJS**: the npm copy is stale. Use the CDN build.

---

## 1. Headless agent adapters and multi-agent wrappers

The design's contract is `run(prompt, workdir, context, allowed_tools, output_schema, limits)`. Each vendor now ships an official SDK that does most of this. **ACP** gives a second, generic route to any agent.

**Claude Agent SDK (TS)**: https://github.com/anthropics/claude-agent-sdk-typescript. npm `@anthropic-ai/claude-agent-sdk` 0.3.282 (2026-09-24). **active**. Licence: Anthropic Commercial Terms (not OSS).
- Runs the Claude Code binary. Its types expose:
  - `outputFormat: {type:'json_schema'}`
  - `allowedTools` / `disallowedTools`
  - `permissionMode`
  - hooks, sessions
  - `total_cost_usd`
  - `pathToClaudeCodeExecutable`
- **ADOPT** for the Claude adapter. Fall back to `claude -p --output-format json` (the documented subprocess route).
- **Caveat (important):** the docs say *"Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK."* Use an API key (or Bedrock/Vertex) per client, or get approval.
- This touches design principle 1 ("under the client's subscription") and risk 6. VERIFY before promising subscription-backed headless runs. Source: https://code.claude.com/docs/en/agent-sdk/overview

**Codex SDK (TS)**: https://github.com/openai/codex (sdk/typescript). npm `@openai/codex-sdk` 0.156.1 (2026-09-23). **active**. Apache-2.0.
- I checked the package: it spawns `codex exec --experimental-json`.
- Options: `outputSchema` (passed as `--output-schema`), `sandboxMode`, `approvalPolicy`, `codexPathOverride`, and thread resume.
- **ADOPT** for the Codex adapter. It already implements our contract, including output_schema.

**Cursor: CLI `agent -p` and `@cursor/sdk`**: https://cursor.com/docs/cli/headless, https://cursor.com/docs/api/sdk/typescript. npm `@cursor/sdk` 1.0.32 (2026-09-22). **active**. Licence: proprietary (Anysphere ToS).
- Headless: `agent -p --output-format json|stream-json --force`.
- The SDK has local agents (working in `local.cwd`) and cloud agents. It needs `CURSOR_API_KEY`, and all inference runs on Cursor's hosted models.
- **ADOPT the CLI** as the adapter. Keep the SDK optional, since it is the client's proprietary dependency.
- No `--output-schema` equivalent was seen, so the core must validate the final JSON itself.

**Agent Client Protocol TS SDK**: https://github.com/agentclientprotocol/typescript-sdk. npm `@agentclientprotocol/sdk` 1.5.0 (2026-09-21). **active**. Apache-2.0.
- Replaces the deprecated `@zed-industries/agent-client-protocol`.
- **ADOPT** as a generic "any ACP agent" adapter. JSON-RPC over stdio, with sessions, permissions and cancel.
- ACP has no output-schema concept. Ask for JSON in the prompt and validate it in the core.

**ACP agent bridges**:
- `@agentclientprotocol/claude-agent-acp` 0.81.2 (2026-09-24) and `@agentclientprotocol/codex-acp` 1.13.1 (2026-09-23). Both Apache-2.0 and **active**. They were renamed from `@zed-industries/*`, which are deprecated.
- Cursor runs natively as an ACP server with `agent acp`, which adds `cursor/create_plan` and `cursor/ask_question` extensions (https://cursor.com/docs/cli/acp).
- Gemini CLI (`@google/gemini-cli` 0.61.0, Apache-2.0), goose and OpenCode also speak ACP. The exact flags are UNVERIFIED.
- **ADOPT** these as runtime subprocesses behind the ACP adapter. They let one adapter drive 5+ agents.

**acpx** (OpenClaw): https://github.com/openclaw/acpx. v0.19.2 (2026-09-23). **experimental** ("pre-1.0… interfaces evolving"). MIT. About 3.2k stars.
- A headless ACP client CLI: built-in `codex`, `claude` and `gemini` profiles, `--format json` NDJSON events, sessions and permissions.
- **BORROW** its launch profiles and permission handling. It is too young to depend on, but it is almost exactly our headless ACP layer.

**coder/agentapi**: https://github.com/coder/agentapi. v0.12.2 (2026-05-27); commits through 2026-09-13. **active**. MIT. About 1.5k stars.
- An HTTP API that drives 11 agents by emulating their terminal UI.
- **SKIP**: screen-scraping a TUI is brittle compared with the native headless modes and ACP.

**vibe-kanban executors crate**: https://github.com/BloopAI/vibe-kanban (`crates/executors`). Rust. Apache-2.0. The company shut down; the project is community-maintained, with commits through 2026-09-19.
- Has executors for claude, codex, cursor, gemini, copilot, amp, opencode, qwen, droid, plus a generic `acp`.
- **BORROW** its per-agent flag sets and log parsing as a reference for adapter conformance tests (for example Claude's `--verbose --include-partial-messages --resume`, and Cursor's `-p --force --trust`).

Others:
- **mozilla-ai/any-agent** (Apache-2.0; PyPI 1.18.0, 2026-02-18; commits 2026-09-21). **SKIP**: Python, and it wraps agent *frameworks*, not coding CLIs.
- **ai-sdk-provider-claude-code / -codex-cli** (MIT, active 2026-09). **SKIP**: they make agents look like LLM providers, which is the wrong abstraction for us.
- **Vercel AI SDK / OpenAI Agents JS**: **SKIP**. Both call models, and the core never does.

## 2. Spec-driven workflow and artifact schemas

**GitHub Spec Kit**: https://github.com/github/spec-kit. v1.0.11 (2026-09-24). **active**. MIT. About 134k stars.
- **BORROW** the template structure for `spec` and `plan`, which maps well onto our REQ/AC/TASK chain:
  - user stories with priority (P1..P3), each with **Given/When/Then** acceptance scenarios
  - `FR-###` functional requirements
  - `SC-###` measurable success criteria
  - an Assumptions section
  - edge cases
  - `[NEEDS CLARIFICATION: …]` markers, which our clarify gate can count
  - tasks `T###` with `[P]` (parallel) and `[US1]` story tags
- Also borrow the idea of presets and extensions (resolution order: project → preset → extension → core) for per-client template overrides.
- Don't depend on it: the templates are prompt-oriented and change often.

**OpenSpec** (Fission AI): https://github.com/Fission-AI/OpenSpec. npm `@fission-ai/openspec` 1.13.2 (2026-09-23). **active**. MIT. About 67k stars.
- **BORROW** the brownfield *delta* model: living specs in `openspec/specs/`, and changes in `openspec/changes/<id>/` with `proposal.md`, `design.md`, `tasks.md` and ADDED/MODIFIED/REMOVED requirement deltas.
- Also borrow the format `### Requirement:` (SHALL/MUST) with `#### Scenario:` WHEN/THEN, and its zod schemas. `RequirementSchema` requires ≥1 scenario, which is exactly our gate "every REQ has ≥1 AC".
- Optional import/export target.
- Note: it ships PostHog telemetry. Opt out with `OPENSPEC_TELEMETRY=0` / `DO_NOT_TRACK` (the exact variable was seen in the code; the value is VERIFY).

**Kiro specs** (AWS, proprietary): https://kiro.dev/docs/specs/.
- Files: `requirements.md` (or `bugfix.md`), `design.md`, `tasks.md`. Requirements-first or design-first.
- **BORROW** the `bugfix` spec variant for a future "bugfix" mode.
- Kiro is widely reported to use EARS phrasing ("WHEN … THE SYSTEM SHALL …"). The docs page I read did not state it, so that is UNVERIFIED. EARS itself is a public method.

**BMAD-METHOD**: https://github.com/bmad-code-org/BMAD-METHOD. v6.12.0 (2026-09-04), commits 2026-09-22. **active**. MIT.
- **BORROW** its review-finding record (a verdict plus evidence per finding) for our `review` schema, and its story-file layout.
- **SKIP** as a runtime: persona prompt packs with heavy ceremony.

**Agent OS**: https://github.com/buildermethods/agent-os. v3.0.0 (2026-01-20), commits 2026-08-29. **active / slow**. MIT.
- **BORROW** its "discover standards → inject standards" prompts for the conventions part of `discover` and for AGENTS.md generation.

## 3. Workflow state machine, gates and trace format

**XState**: https://github.com/statelyai/xstate. npm `xstate` 5.33.2 (2026-09-15). **mature**. MIT.
- **BORROW, don't depend on it, in v1.** Our modes are YAML stage lists with loop-backs and retry budgets; a ~150-line interpreter over the manifest is clearer than generating XState configs.
- Borrow its guard semantics (gate = guard), persisted-snapshot idea (snapshot → `run.json`) and model-based path testing.
- Re-evaluate if parallel stages arrive.

**Vercel Workflow DevKit**: https://github.com/vercel/workflow. npm `workflow` 4.8.9 (2026-09-15); `@workflow/world-local` persists to the local filesystem. **active**. Apache-2.0.
- **SKIP for v1.** It depends on `"use workflow"` compile-time directives and bundler integration.
- It is the most plausible "durable without a server" option if resumable long runs become painful.

**DBOS Transact TS**: https://github.com/dbos-inc/dbos-transact-ts. npm 5.1.10 (2026-09-24). **active**. MIT.
- **SKIP**: it needs Postgres (SQLite support is UNVERIFIED), and the design says no DB in v1.

**Restate / Inngest / Temporal / Absurd**: **SKIP**. Each needs a server or Postgres (see landscape §3).

**OpenTelemetry GenAI semconv (JS)**: https://github.com/open-telemetry/semantic-conventions (v1.44.0, 2026-08-04). JS package `@opentelemetry/semantic-conventions` 1.43.0. **experimental**. Apache-2.0.
- The `ATTR_GEN_AI_*` constants are exported only from the *experimental* attributes module; the stability is still Development.
- Operation names now include `invoke_agent`, **`invoke_workflow`**, `execute_tool` and `chat`.
- **BORROW** the attribute names for `events.jsonl`: `gen_ai.operation.name`, `gen_ai.agent.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.*`, `gen_ai.conversation.id`. Pin the version.
- **ADOPT** `@opentelemetry/sdk-node` 0.222.0 plus an OTLP exporter as an *optional* export (off by default) so clients can pipe runs into Langfuse or Jaeger.

**OpenInference** (Arize, Apache-2.0): **SKIP**. It is a competing convention, and Phoenix is ELv2.

## 4. Worktrees and sandboxes for parallel agents

**Plain `git worktree` via execa**: `execa` 10.0.1 (2026-07-31). MIT.
- **ADOPT** execa for all subprocesses (agents, git, build tools).
- Use raw `git worktree add/remove/prune --porcelain`. simple-git has no first-class worktree API (VERIFY), so skip it.

**vibe-kanban `crates/worktree-manager`**: https://github.com/BloopAI/vibe-kanban. Apache-2.0. Community-maintained.
- **BORROW** its orphan-worktree cleanup, branch naming and locking logic.

**claude-squad**: https://github.com/smtg-ai/claude-squad. v1.0.20 (2026-08-20). **active / slow**. **AGPL-3.0**.
- **SKIP**: AGPL, and tmux/TUI-centric. Don't copy code.

**Crystal → Nimbalyst**: https://github.com/stravu/crystal is deprecated and archived (last tag v0.3.5, 2026-02-26). Its successor is https://github.com/Nimbalyst/nimbalyst (v0.78.5, 2026-09-24, MIT, **active**).
- **SKIP**: desktop apps. Only the UX ideas are relevant.

**container-use** (Dagger): https://github.com/dagger/container-use. Last tag v0.4.2 (2025-08-15); commits 2026-08-12. **experimental** ("early development"). Apache-2.0.
- **SKIP for v1**: it needs the Dagger engine and relies on the agent choosing to use its MCP tools. Watch it.

**Anthropic sandbox-runtime (`srt`)**: https://github.com/anthropic-experimental/sandbox-runtime. npm `@anthropic-ai/sandbox-runtime` 0.0.77 (2026-09-18). **experimental** (0.0.x). Apache-2.0.
- An OS-level sandbox (bubblewrap on Linux, Seatbelt on macOS) with filesystem and network allowlists around any command.
- **ADOPT (pinned, optional)** to enforce policy egress and protected paths around *any* agent CLI, not just Claude. Windows support is UNVERIFIED.

**Docker Sandboxes (`sbx`)**: https://github.com/docker/sbx-releases. v0.34.0 (2026-06-26). **Proprietary** (Docker Inc.).
- **SKIP as a dependency.** Document it as an optional client-side runtime (microVM per agent).

**Native agent sandboxes**: Codex `sandboxMode`/`approvalPolicy` and Claude `permissionMode`/`allowedTools`.
- **ADOPT**, via the SDKs in §1. This is the first line of defence; `srt` is the second.

## 5. Verification

**Test lock / anti-tampering**: build this in the core (sha256 of locked test files plus `git diff --name-only` against the protected globs). Nothing off-the-shelf fits exactly.
- **TDD Guard**: https://github.com/nizos/tdd-guard. v1.7.0 (2026-06-23). MIT. About 2.3k stars.
- Its successor, **Probity**: https://github.com/nizos/probity. v1.10.1 (2026-09-15). **active**. MIT. Hooks for Claude Code, Codex and Copilot CLI.
- **BORROW** their hook-based "block edits to tests / test-first" enforcement for the *interactive* plugins. Don't depend on them: they use an LLM validator, and our gate must be deterministic.

**Assertion-vs-compile failure (risk 3)**:
- **ADOPT** the runners' machine reporters: Vitest/Jest `--reporter=json` or JUnit; `dotnet test --logger trx` (or a JUnit logger).
- Classify failures from the report, not from stdout.

**StrykerJS**: https://github.com/stryker-mutator/stryker-js. `@stryker-mutator/core` 10.0.0 (2026-08-14), with vitest and jest runners. **mature**. Apache-2.0.
**Stryker.NET**: https://github.com/stryker-mutator/stryker-net. `dotnet-stryker` 5.0.0 (2026-09-11). **mature**. Apache-2.0.
- **ADOPT both as an optional verify step**, scoped to changed files (StrykerJS incremental mode, Stryker.NET `--since`).
- A surviving-mutant threshold on the diff proves the acceptance tests actually constrain the code. It is slow, so make it a policy flag.

**gitleaks**: https://github.com/gitleaks/gitleaks. v8.30.1 (2026-02-21). **mature, feature-complete** ("security patches only"). MIT. About 29k stars.
- **ADOPT** now (stable, SARIF/JSON output).
- The author moved to **Betterleaks** (https://github.com/betterleaks/betterleaks, v1.8.1 2026-08-18, MIT, **active**). Watch it and swap once it is proven.

**TruffleHog**: v3.97.9 (2026-09-24). **AGPL-3.0**. **SKIP**, because of the licence. (Running it as an unmodified external CLI is legally different, but not worth it.)

**Dependency audit**:
- **ADOPT** `npm audit --json` and `dotnet list package --vulnerable --format json` (built in).
- **ADOPT** **OSV-Scanner** (https://github.com/google/osv-scanner, v2.6.0 2026-09-14, Apache-2.0, **active**) as the single cross-stack scanner (npm and NuGet lockfiles, JSON/SARIF output).
- **SKIP** audit-ci / better-npm-audit (last releases in 2024).

**Trivy**: v0.74.0 (2026-08-14). Apache-2.0.
- **SKIP / caution**: TeamPCP compromised its release tooling and GitHub Action in 2026-03 (https://www.microsoft.com/en-us/security/blog/2026/03/24/detecting-investigating-defending-against-trivy-supply-chain-compromise/).
- If a client uses it, pin by digest.

**Semgrep**: 1.178.0 (2026-09-23). Engine is **LGPL-2.1**; the registry rules are under a separate non-OSI licence (VERIFY).
- Optional SAST, run as an external CLI. **SKIP by default.**

**Diff size / scope**: **build** it (`git diff --numstat` + picomatch against the plan's file scope). About 50 lines.
- **danger-js** (MIT, 14.0.7 2026-08-28, supports GitHub and Bitbucket Cloud/Server): **SKIP**. It runs in PR CI, but our gate runs before the PR exists.
- **knip** (ISC): optional lint for unused dependencies and exports.

**Output format**: emit `verification.json` *and* SARIF 2.1.0, so §6's reviewdog can post it to Bitbucket or GitHub unchanged.

## 6. Independent AI code review (Bitbucket-capable)

**PR-Agent**: https://github.com/the-pr-agent/pr-agent (moved from qodo-ai; donated to the community, "being donated to an open-source foundation"). v0.46.0 (2026-09-21). **active**. MIT (the LICENSE is now "The PR Agent"). About 12k stars.
- Providers include `bitbucket` and `bitbucket_server` (checked in code), GitHub, GitLab, Azure DevOps and Gitea.
- **BORROW** its review/describe/improve prompt TOMLs and finding categories for our `review` stage prompt.
- **SKIP as a dependency**: it calls LLMs itself through LiteLLM (Python), which violates "the core never calls a model". A client may still run it as a separate CI bot.

**reviewdog**: https://github.com/reviewdog/reviewdog. v0.21.2 (2026-09-18). **mature**. MIT.
- Posts SARIF / rdjson / checkstyle diagnostics as **Bitbucket Code Insights** reports. For Bitbucket Server set `BITBUCKET_SERVER_URL`; only `nofilter` mode works on Bitbucket.
- On GitHub it posts PR review comments and checks.
- **ADOPT** in `deliver`: convert `review` findings and verify results into rdjson/SARIF and let reviewdog annotate the PR.

**Review executor**: our own `review` stage using a *different* agent through §1 adapters (as in the design). No extra dependency.

**SKIP**:
- coderabbitai/ai-pr-reviewer (last commit 2023-11-26; archived-in-practice).
- villesau/ai-codereviewer (2023).
- **Kodus** (kodustech/kodus-ai; **AGPLv3** per its README badge).

## 7. Forge and integration layer (Bitbucket, GitHub, Jira, Confluence, MCP)

**MCP TypeScript SDK**: https://github.com/modelcontextprotocol/typescript-sdk. `@modelcontextprotocol/sdk` 1.30.1 and the v2 split package `@modelcontextprotocol/client` 2.1.0 (both 2026-09-23). **mature**. MIT.
- **ADOPT**:
  - `Client.callTool()` for deterministic sink/source calls when a sink uses MCP as transport.
  - The server side for the `/factory` front end.
- Pick v1 or v2 at project start and pin it (v2 package split VERIFY).

**Atlassian Rovo MCP server (official, hosted)**: https://github.com/atlassian/atlassian-mcp-server (repo: Apache-2.0 plugins/skills; commits 2026-09-15). Endpoint `https://mcp.atlassian.com/v2/mcp`. **active**.
- Covers Jira, Confluence, JSM, **Bitbucket Cloud** (`read_bitbucket` / `write_bitbucket`; the workspace must be linked to an org), Compass and Loom. OAuth 2.1 or API token. Cloud only.
- **ADOPT** as the agent *read* tool for Cloud clients, with write groups off in agent stages.

**sooperset/mcp-atlassian**: https://github.com/sooperset/mcp-atlassian. v0.23.1 (2026-08-18), commits 2026-09-19. **active**. MIT. Python (`uvx`).
- Jira and Confluence on **Cloud and Server/DC**, 98 tools, `READ_ONLY_MODE` and `ENABLED_TOOLS`.
- **ADOPT** for Server/DC or self-hosted clients.

**Bitbucket MCP servers**:
- **JaviMaligno/mcp-server-bitbucket** (MIT; TS+Py; v0.13.0 2026-08-18; commits 2026-09-23; **active**). Broad Cloud coverage (PRs, pipelines, diffs, branch restrictions). **ADOPT** as the agent read tool when Rovo's Bitbucket tools aren't available.
- **b1ff/atlassian-dc-mcp** (MIT; v0.35.0 2026-09-22; **active**). Jira, Confluence and Bitbucket **Data Center**. **ADOPT** for DC clients.
- MatanYemini/bitbucket-mcp (MIT; last tag 2025-12) and aashari/mcp-server-atlassian-bitbucket (ISC; 3.1.0 2026-02-17): **SKIP**, slowing.

**GitHub MCP server (official)**: https://github.com/github/github-mcp-server. v1.12.2 (2026-09-16). **mature**. MIT.
- **ADOPT** as the agent read tool (read-only toolsets).

**TS REST clients for deterministic sinks (deliver, Jira/Confluence publish)**:
- `@octokit/rest` 22.0.1 (2025-10-31, MIT): **ADOPT**. Stable; the slow cadence is fine.
- `jira.js` 6.2.0 (2026-08-24) and `confluence.js` 3.2.0 (2026-08-10), both MIT and **active**: **ADOPT**.
- Bitbucket: `bitbucket` (MunifTanjim, last 2024-05) **SKIP**. `@coderabbitai/bitbucket` (Apache-2.0, 1.1.4 2025-06, typed Cloud+Server clients) **BORROW** its approach: generate our own thin client with `openapi-typescript` 7.13 + `openapi-fetch` (MIT) from Atlassian's Bitbucket OpenAPI spec, covering only the ~10 endpoints deliver needs.
- **Auth note:** Bitbucket Cloud app passwords stopped working on **2026-06-09**. Use API tokens or OAuth (https://www.atlassian.com/blog/bitbucket/bitbucket-cloud-enters-phase-2-of-app-password-deprecation).

**mcp-use** (MIT): **SKIP**. It is an LLM-driven MCP client, and we need deterministic calls.

## 8. Estimation and xlsx export

**AI estimation OSS**: nothing mature found.
- ips-ag/project-estimate (https://github.com/ips-ag/project-estimate; MIT; about 0 stars; .NET + Semantic Kernel + Azure): three-point estimates from consultant/analyst/architect/developer agents. **SKIP**; borrow the idea only.
- GitHub's `software-estimation` topic is mostly COCOMO/PERT calculators. **BORROW** the PERT formula `(O+4M+P)/6` as an optional "expected" column next to the sheet's simple average. Code computes it, never the model.

**ExcelJS**: https://github.com/exceljs/exceljs. npm 4.4.0 (2023-10-19). About 15k stars; 655 open issues. MIT. **mature but stalled** (no npm release in about 3 years).
- **ADOPT (pinned)**. It is still the only permissive JS library with styling, formulas, column widths and read-modify-write.
- Our sheet is small, which limits the risk.
- Consider filling a copy of the Folio3 template instead of drawing from scratch. How well formatting survives the round-trip is VERIFY.

**SheetJS CE**: https://docs.sheetjs.com. Current 0.20.3 is served only from `cdn.sheetjs.com`; npm `xlsx` is stuck at 0.18.5 (2022, known advisories). Apache-2.0.
- Cell styling is a Pro feature (VERIFY). **SKIP** for styled output. If ever used, install from the CDN tarball, never npm.

**write-excel-file** (MIT, 4.1.1, 2026-06-08): small, supports styles. **Fallback** if ExcelJS breaks.

**excelts / "Documonster"** (cjnoname; about 113 stars; npm says MIT, repo says Apache-2.0): **SKIP**, too young.

## 9. Prototype generation (React + Vite clickable mocks)

**create-vite**: `create-vite` 9.2.1 (2026-09-10). MIT. **ADOPT**: the scaffold is `npm create vite -- --template react-ts`.

**shadcn CLI + registry**: https://github.com/shadcn-ui/ui. `shadcn` 4.21.0 (2026-09-04). **mature**. MIT.
- **ADOPT**: publish a private Folio3 registry (`registry.json` items for login, list/detail, dashboard, forms and the "mock-up" banner). The agent then composes screens with `shadcn add @folio3/...` instead of inventing UI.
- Screens map to modules via item names.

**MSW** 2.15.0 and **react-router** 8.4.0 (both MIT): **ADOPT** for fake data and screen navigation, so the mock is clickable without a backend.

**Playwright** 1.63.0 (Apache-2.0): **ADOPT** for the prototype gate ("builds and runs": visit every route, assert the banner is present, take screenshots for the presales pack).

**SKIP** (each is a full app with its own LLM loop, which conflicts with "the core never calls a model"):
- **bolt.diy** (MIT; last tag v1.0.0 2025-05-12; last commit 2026-02-07; slowing).
- **open-lovable** (firecrawl, MIT; last commit 2025-11-19; stale; needs hosted sandboxes).
- **Dyad** (Apache-2.0 except `src/pro`; v1.16.0 2026-09-17; active). Its system prompts are worth reading.
- **Onlook** (last tag 2025-07; licence UNVERIFIED).

## 10. Config layering and schemas

**zod**: https://github.com/colinhacks/zod. 4.6.5 (2026-09-13). **mature**. MIT.
- **ADOPT** as the single source of truth for artifact schemas (spec, plan, impact, estimate, review, verification) and config.
- Zod 4's native `z.toJSONSchema()` produces the `output_schema` sent to Claude/Codex, so `zod-to-json-schema` is not needed.
- VERIFY that the emitted schema satisfies OpenAI strict-mode rules (all properties required, `additionalProperties:false`).

**c12** (unjs): https://github.com/unjs/c12. Stable v3.3.4 (2026-04-01); v4.0.0-rc.2 (2026-09-22). MIT.
- **BORROW / optional**. Its `extends` layering and rc/env loading fit org → client → project → run.
- But our rule "security keys may only get stricter" needs a custom merge.
- Plan: **ADOPT `yaml` (ISC 2.9.1) + `defu` (MIT) for ordinary keys**, plus a hand-written monotonic merge for the policy keys (allowed agents/models, egress, protected paths, write sinks), validated by zod after each layer.

**cosmiconfig** 10.0.1 (MIT): **SKIP**. Our config paths are fixed; we don't need multi-format discovery.

**ajv** 8.20 (MIT): **SKIP** unless we publish JSON Schemas for third parties; zod covers the rest.

**CLI shell (not asked, for completeness)**: `commander` 15.0.0 (MIT).

---

## Recommended reuse per component

| Core component | Adopt (depend on) | Borrow (pattern/template) | Build ourselves |
|---|---|---|---|
| Agent adapters | `@openai/codex-sdk`; `@anthropic-ai/claude-agent-sdk` (API-key auth, see caveat); Cursor `agent -p` CLI; `@agentclientprotocol/sdk` + claude-agent-acp / codex-acp / `agent acp` | acpx profiles; vibe-kanban executor flags | Adapter contract, JSON validation, conformance tests |
| Spec / plan / review schemas | zod 4 | Spec Kit spec/tasks templates (FR/SC/Given-When-Then, NEEDS CLARIFICATION); OpenSpec deltas + Requirement/Scenario schema; BMAD finding verdict+evidence; Agent OS standards discovery | REQ→AC→TEST→TASK ID chain, schema set |
| Run state machine + gates | — | XState guard/snapshot semantics | Manifest interpreter, gate engine, retry/escalate |
| Trace / events | `@opentelemetry/sdk-node` + OTLP (optional export) | OTel GenAI attribute names (`invoke_workflow`, `invoke_agent`, `gen_ai.usage.*`) | `events.jsonl` writer, hashing |
| Worktrees / sandbox | execa; `@anthropic-ai/sandbox-runtime` (optional, pinned); native Codex/Claude sandbox modes | vibe-kanban worktree-manager cleanup | Worktree lifecycle, branch ownership |
| Verify runner | gitleaks (→ Betterleaks later); OSV-Scanner; npm audit / dotnet list --vulnerable; StrykerJS / Stryker.NET (optional); test-runner JSON/JUnit reporters | TDD Guard / Probity hooks (interactive plugins) | Test lock (hash), scope/size check, failure classifier, SARIF output |
| Independent review | reviewdog (post findings to Bitbucket Code Insights / GitHub) | PR-Agent prompts and categories | Review stage via second agent |
| Forge sinks | `@octokit/rest`; jira.js; confluence.js; openapi-typescript + openapi-fetch (Bitbucket) | `@coderabbitai/bitbucket` generated-client approach | Thin Bitbucket client (~10 endpoints), deliver stage |
| MCP tools / client | `@modelcontextprotocol/sdk` (or v2 `/client`); Atlassian Rovo MCP (Cloud); sooperset/mcp-atlassian (Server/DC); mcp-server-bitbucket or atlassian-dc-mcp; github-mcp-server | — | Per-stage tool allowlist, read-only defaults |
| Estimate engine | ExcelJS (pinned; write-excel-file fallback) | PERT `(O+4M+P)/6` | Rollups, buffers, cost, leverage tags, sheet layout |
| Prototype | create-vite, shadcn CLI + private registry, MSW, react-router, Playwright | Dyad/bolt.diy prompts (read only) | Registry items, banner, screen↔module map |
| Config layering | zod, yaml, defu | c12 `extends` layering | Monotonic "stricter-only" policy merge |

**Top follow-ups (VERIFY):**
1. Whether Anthropic's SDK auth rule allows headless runs under a client's Claude subscription on the client's own machine.
2. That Cursor CLI JSON output is stable enough without a schema flag.
3. The MCP TS SDK v1 vs v2 choice.
4. How well ExcelJS round-trips the Folio3 template.
5. Whether zod's JSON Schema output passes Codex strict mode.
