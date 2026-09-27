# AI Factory: build brief (2026-09-27)

You are building the AI Factory POC on Ahsan's laptop (WSL2 Ubuntu). The design is final enough to build; tweak as we go with Ahsan. The stage catalogue `stages-aligned.md` is the source of truth; where docs disagree, its precedence rule applies (newest wins), and its §6 gap decisions plus the "Ahsan 2026-09-27" notes win over everything.

## Goal and demo
- A TypeScript CLI `factory` that turns a request (a typed prompt, optionally a Jira ticket) into a verified PR.
- Demo on Thu 2026-10-01, live, on Ahsan's real .NET + Postgres backend repo (it has tests). Separate Next.js/TS frontend repo comes after.
- Build order: a thin brownfield slice end to end first (prompt → spec → plan → approval → locked tests → implement → task verify → integrate → accept → review → deliver as a PR), then deepen. Greenfield, estimate, linked runs and jcode are in scope after the slice.

## Hard rules
- Client code stays on this laptop. Never copy it anywhere except the model APIs Ahsan configured.
- API keys live in an env file Ahsan creates (`~/.factory/.env`). Never ask for keys in chat, never print them, never commit them.
- The local DB connection string is read-only; used only by discover.
- Don't push to any remote until Ahsan names the factory's GitHub repo.
- Runtime: Docker Engine CE or Podman inside WSL2. Not Docker Desktop.
- Docs for Ahsan: plain words, one-page summary first, no legend codes. Replies short.

## Stack
TypeScript strict, ESM, Node 22, npm. zod 3 is the single schema source (JSON Schema for structured output). commander, yaml, vitest. @anthropic-ai/sdk, openai, @anthropic-ai/claude-agent-sdk, @openai/codex-sdk. Pin versions.

## Modules, in build order
1. **contracts** (`contracts.md` §1–§10): zod schemas for artifacts, ledger events, pack recipes, verify artifacts.
2. **run manager** (`run-manager.md`): ledger at `~/.factory/ledger/<runId>/` = append-only `events.jsonl` (fsync, torn-tail repair) + content-addressed artifacts; RunState only by replay; skip a step on resume when its inputsHash is unchanged; execution lock per repo with a fencing epoch; ledger lock per run; hardened host git (no hooks, no filters); sinks do intent → look-up → create; `delivered` stays open until merge. Caps park the run: 6 attempts per task; cost bugfix $5, S $5, M $10, L $20; 2× wall clock. Human decisions only on a TTY (`factory approve <run> <hash>`).
3. **gate engine** (`gate-engine.md`): producers (sealed containers) separate from pure predicates; lock set + config-integrity set; hash-bound approvals and waivers; one failure ladder (§2.6); pushed commit = gated tree SHA + one manifest-only commit.
4. **verify runner / test lab** (`verify-runner.md`): rooms copy (git archive) → restore through a TLS feed proxy (URL-prefix allowlist; the proxy injects private-feed credentials) → build with no network → test in the Postgres container's network namespace. Stop every container before reading results. Per-stage expectations (expectPass / expectFail with failureKind / compareToBaseline). Locked tests must pass the first time. Classify as infra only if a core probe fails. POC: Postgres only; refuse Testcontainers, SQL Server, Windows-only targets.
5. **context builder** (`context-builder.md`): pointers, not dumps; budgets read-small 15K, read-large 30K, agent 40K, local ≤16K; untrusted text only in the read-only room; the coding container gets a dummy env; packs stored and reused by sha; no compaction; plan stubs before author-tests.
6. **runners** (`adapters.md`, `core-design.md` §14/§18): ApiRunner = our own read-only loop (read_file, search, repo_map; no write/shell/network; schema-validated output, ≤2 re-asks, ≤8 turns). ClaudeAgentRunner and CodexRunner wrap the vendor SDKs inside the sealed coding container (no network except the model API; restored packages mounted read-only; new deps only via the plan). JcodeRunner later (experiment, `research-jcode.md`).
7. **stages** (brownfield, `stages-aligned.md` §1–§2): discover + baseline + onboarding card → intake (prompt primary, treated as untrusted) → ground (Opus 5.5) → clarify (3× Sonnet 5 sketches, Opus clarifier, ≤5 questions + ≤3 in a second round) → specify (2× Opus 5.5 + 1× GPT; Sonnet 5 for low-risk bugfix) → merge → lint → critic (GPT) → round trip → spec gate → impact → plan (Opus 5.5 always) → approval card (lists every file the plan touches) → stub commit → author-tests (separate engine, never sees the plan's approach; must fail twice on base with assertion/not-implemented) → lock → implement per task (Sonnet 5 → Opus 5.5) ⟲ task verify → integrate → accept (no model) → review (GPT, at most one repair loop) → deliver (gitleaks, PR).
8. **CLI**: `factory start "<prompt>" --project <name>`, `status`, `approve`, `steer`, `revise`, `resume`.

Each module ships with vitest tests. Small commits with clear messages.

## Stack pack for the demo
.NET: `dotnet restore` / `dotnet build --no-restore` / `dotnet test --no-build --logger trx`; parse TRX for per-test results and failure kinds. Postgres service from the environment contract, not Testcontainers.

## Other visuals
- Guide: https://claude.ai/artifact/18rgs8t8tP7JWA8yt3fE5e
- Workflow diagrams: https://claude.ai/artifact/GGKA5R2cq7Bq9axEqrmwgm
