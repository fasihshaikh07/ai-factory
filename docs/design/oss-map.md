# Open-Source Reuse by Workflow Step (2026-09-25)

**Adopt** = we depend on it. **Borrow** = we copy a pattern or template, not code. Sources: reuse.md, research-*.md, research-jcode.md.
Status and licence details are in reuse.md and research-conventions-quality.md.

| Step | Open source used | How we use it | Kind |
|---|---|---|---|
| **Agents (all steps)** | Claude Agent SDK, Codex SDK, Cursor CLI, **jcode SDK** (local/cheap tier), ACP SDK (optional) | Adapters: send one stage task, get schema-checked JSON back | Adopt |
| **Local models** | Ollama / vLLM + Qwen3.6, gpt-oss | T0 tier behind jcode | Adopt |
| **Onboard / discover** | tree-sitter (Aider-style ranked repo map); **graphify** only above ~300 files; ripgrep | Code map and convention counts | Adopt |
| | Existing lint configs: ESLint/typescript-eslint, Roslyn analyzers, dotnet format | Run on untouched repo → baseline findings | Adopt |
| | Agent OS "standards discovery" | Pattern for mining conventions | Borrow |
| **Run the app (environment)** | Testcontainers (.NET + Node), Docker Compose, **MSW** (Node/React), **WireMock.Net** (.NET) | Throwaway DBs and fake external APIs | Adopt |
| **Intake / clarify / specify** | GitHub **Spec Kit** (clarify limits, NEEDS CLARIFICATION, Given/When/Then), **OpenSpec** (ADDED/MODIFIED/REMOVED deltas, "every requirement has a scenario"), EARS notation | Spec format and lint rules | Borrow |
| | zod 4 | Schemas → JSON Schema for agent output | Adopt |
| **Design / prototype** | create-vite, shadcn CLI + registry, react-router, MSW, **Playwright** | Clickable mock; UI acceptance walk | Adopt |
| | Figma MCP (official) | Optional publish after approval | Adopt (later) |
| **Plan / impact** | graphify or repo map queries; compiler/LSP (tsc, dotnet build) | Impact evidence | Adopt |
| **Author tests** | xUnit + WebApplicationFactory, Vitest/Jest + Supertest, Playwright | Acceptance test harness per stack | Adopt |
| **Implement** | Lint-in-loop via ESLint / dotnet format hooks | New violations back to agent | Adopt |
| **Verify: quality** | typescript-eslint, eslint-comments, Roslyn analyzers, **dependency-cruiser**, **ArchUnitNET**, **jscpd**, knip, c8/coverlet + **diff-cover**, axe-core | New-code-only gates | Adopt |
| **Verify: security** | **gitleaks**, **OSV-Scanner**, npm audit / dotnet list --vulnerable, squawk (Postgres migrations), Stryker (optional mutation) | Secrets, dependencies, migrations | Adopt |
| **Review** | PR-Agent prompts and categories; BMAD finding format (verdict + evidence) | Review rubric | Borrow |
| | **reviewdog** | Post findings as PR annotations (Bitbucket / GitHub) | Adopt |
| **Deliver / integrations** | Octokit, jira.js, confluence.js, openapi-typescript (thin Bitbucket client), MCP TS SDK, Atlassian Rovo MCP, mcp-atlassian, github-mcp-server | PRs, Jira tasks, Confluence spec | Adopt |
| **Estimate** | **ExcelJS** (pinned); PERT formula | Your sheet format; arithmetic in code | Adopt / Borrow |
| **Run state / trace** | XState semantics; OpenTelemetry GenAI attribute names | State machine design; event field names | Borrow |
| **Worktrees / sandbox** | git worktree via execa; Anthropic sandbox-runtime (optional); vibe-kanban cleanup logic | Isolation per run | Adopt / Borrow |
| **Config** | zod, yaml, defu; c12 layering pattern | Layered config | Adopt / Borrow |
| **Eval (the factory's own)** | **Inspect AI**, SWE-bench task-mining method, SWT-bench grading, CommitSuite dataset | Eval runner and task format | Adopt / Borrow |
| **Greenfield blueprint** | `dotnet new` templates, create-vite, Copier | Scaffold + org overlay | Adopt |

## What we build ourselves (nothing fits)

- run manager and stage runner
- gate engine
- test lock
- diff-scope and size checks
- context builder with token budgets
- router / Decider
- trace chain (REQ → AC → TEST → TASK → commit)
- stricter-only config merge
- estimate rollups and leverage tags
- adapter conformance tests

## Considered and skipped (why)

| Skipped | Why |
|---|---|
| OpenHands, Open SWE, Devin-like platforms | Whole agent platforms; we wrap agents instead |
| PR-Agent as a runtime, bolt.diy, open-lovable, Dyad | They call models themselves (compliance, cost control) |
| claude-squad, TruffleHog, Kodus | AGPL |
| GitNexus | Non-commercial licence |
| Trivy | Supply-chain compromise, March 2026 |
| SonarAnalyzer.CSharp | Source-available, not open source |
| NetArchTest | Stale since 2021 |
| Workflow engines (Temporal etc.), vector DBs, Backstage | Not needed for v1 |
| BMAD workflow | Too documentation-heavy (only its finding format is borrowed) |
