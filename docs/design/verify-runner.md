# Verify Runner v2: Design (2026-09-27)

Owned by Claude (Ahsan, 2026-09-26). v2 applies an independent fresh-context review (18 findings; §6). Evidence: research-verify-runner.md (this component), research-no-docker.md, research-conventions-quality.md, research-q-env-noncode-greenfield.md Q1/Q8. Tags: **[docs]**, **[source]**, **[paper]**, **[preprint]**, **[practitioner]**, **UNVERIFIED**, **[EVAL]** = our estimate, measure when built.

---

## One-page summary (read this; the rest is reference)

**What it does.** Every time code changes, the verify runner builds it and runs its tests, lint and security checks, then writes down exactly what happened. The gates decide pass or fail from that record. The AI never reports its own results.

**How it works, in three rooms:**
1. **Copy room.** The factory takes a clean copy of the exact commit being judged. It isn't the agent's workspace, and it has no leftovers or git history.
2. **Download room.** Packages (NuGet, npm) are downloaded through a factory gatekeeper. It allows only downloads from the approved package feeds and adds any private-feed passwords itself, so the repo's code never sees them. Package install scripts are off.
3. **Test room.** Build, tests and lint run with **no internet at all**, next to a throwaway database that only this room can reach.

The rooms are Docker Engine or Podman containers inside WSL2. Each one is stopped before its results are read, then thrown away.

**Why you can trust a "pass":**
- A pass needs a results file that lists **every expected test by name** with the expected outcome. At least as many tests must have run as were found beforehand, and the exit code must agree.
- "0 failures" alone never passes. A test that was skipped, filtered out or never ran counts as a failure.
- The factory chooses where results go and reads them only after every process in the room has stopped.
- It isn't bulletproof: some test tools write their report from inside the test code. So the tests themselves are locked, and faking a pass would mean faking every expected test at once.
- This matters because AI agents do cheat. In one study o3 tampered with scoring in 30% of runs on a research-engineering benchmark (under 1% on another), and in another, one agent deleted test files in 3.4% of tasks.

**Flaky tests** are re-run once, but the tests written for your ticket must pass the first time. If many tests fail together, the factory checks whether the database or app is actually down. Only if it is does it call it an environment problem instead of a code bug.

**What this means for you:**
- The POC supports **Postgres** as the test database. Repos on SQL Server or other engines are refused with a clear reason, and support can be added later.
- Repos whose own tests start Docker containers (Testcontainers) are refused for now. Windows-only .NET projects (WPF, old .NET Framework) are refused too.
- Some newer .NET test setups need one small package to write reports. The onboarding card will say so.
- The first run on a repo is slow (downloads). Later runs reuse verified packages. Times are recorded, so budgets come from real numbers.

**Choices I made (tell me if you disagree):**
- Coverage on changed lines is checked once per run, not after every task.
- Mutation testing (testing the tests) is **off**; the evidence for it on AI-written tests is mixed.
- New packages the AI adds must exist on the registry and be at least 30 days old.

**Not proven yet (measure when built):** build and test times on your .NET repo, and which .NET test mode it uses.

---

## Part 2. Design detail

### 2.1 Where it sits
```
gate engine: produce(kind, treeSha, stage, expectations) ─► verify runner ─► typed result artifacts ─► ledger
                                                                    (tool + image versions, timings)  └► predicates decide
```
- It is the **producer** half of gate-engine §2.1: it runs tools, it doesn't decide.
- Inputs: the gated `treeSha`, the stage, the **expectations** (§2.4) and the repo's environment contract (research-q-env Q1).
- Outputs: `TestRun`, `LintRun`, `BuildRun`, `MigrationRun`, `AuditRun`, `SecretScan`, `AcceptEvidence`, `Timing` (§2.10).

### 2.2 Run flow
```
1. copy     host: git archive <treeSha> → ~/.factory/tmp/<runId>/<n>/ (ext4, no .git); host: git diff -U0 base..treeSha → patch
2. restore  container R: network only via the feed proxy (§2.3); per-run writable package folders over a read-only verified cache
3. build    container B1: --network none; dotnet build / tsc / vite build / next build; SARIF + build log → results mount 1
            stop B1 → core reads results mount 1
4. test     container B2 sharing the db's network namespace (§2.5): stack runner with core-forced reporters → results mount 2
            stop B2 (every process killed) → core reads results mount 2
5. clean    remove containers by label (run-manager §2.10); delete the copy dir and per-run package folders
```
- **Stop before reading.** Test code can leave a background process that rewrites a report after the runner exits. The core stops the container, which kills every process in it, and only then reads the results. Each phase has its own fresh results mount, so tests can't rewrite the lint or build output.
- **Never reuse `bin/obj`.** MSBuild incrementality is timestamp-based and keeps outputs of deleted files (how often this misleads is UNVERIFIED), and the agent's `bin/obj` is untrusted.
- **Container hardening:** non-root `--user`, `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--pids-limit`, memory and CPU caps **[EVAL]**, no Docker socket, and no host mounts except the copy dir, the results mount and the package folders.
- **Images:** a stack-pack image map from toolchain versions (`global.json`, `.nvmrc`, `engines`) to images **pinned by digest**, with the digest recorded in `toolVersions`. UI images include Playwright's browsers. No Python needed: diff coverage is computed in the core (§2.7).

### 2.3 Restore: feed proxy and caches
**Feed proxy (core-owned, on the host):**
- It terminates TLS with a factory CA that only container R's image trusts, and allows only `GET`/`HEAD` to **full feed URL prefixes** (e.g. `https://api.nuget.org/v3/`, `https://registry.npmjs.org/`, the project's private feed paths). Host-only allowlists are unsafe on shared-tenant hosts such as `pkgs.dev.azure.com/<anyone>`.
- **Private-feed credentials are added by the proxy** for their URL prefix. R never holds a token, so repo code running during restore can't read it. Credentials are referenced in project config, never stored in the repo.
- R has no DNS of its own; the proxy resolves names. Residual leak: data encoded in request paths to allowed feeds, readable only by the feed operator.
- `dotnet restore` evaluates repo MSBuild files, so repo code may run here (UNVERIFIED; treated as true). That's why R is limited to the proxy.
- `nuget.config`, `.npmrc`, `.yarnrc*` and `Directory.Packages.props` join the gate engine's config-integrity set, so an agent can't redirect feeds.

**Caches (fixes cache poisoning):**
- Repo code in R could otherwise overwrite an extracted package (for example a `build/*.targets` file), poisoning every later run on that repo, baselines included.
- **npm:** npm's cache is content-addressed and integrity-checked on insertion and extraction [docs]. It's shared per repo as a read-only lower layer; each run writes to its own folder, and `node_modules` is extracted fresh per run.
- **NuGet:** the shared per-repo cache holds only **`.nupkg` files**, promoted by the core after checking each file's SHA-512 against the registry's published hash (UNVERIFIED mechanism detail). Each run extracts into its own fresh `NUGET_PACKAGES` folder. The extra extraction time is **[EVAL]**.
- `npm ci --ignore-scripts` always (npm 12's default since July 2026), then `npm rebuild` only for a per-repo allowlist confirmed at onboarding. `dotnet restore --locked-mode` when a lock file exists; otherwise the resolved `obj/project.assets.json` is saved as evidence. [docs]
- Tools the contract needs (e.g. `dotnet-ef`) are restored in R like packages.
- Caches have a per-repo size cap with oldest-first eviction **[EVAL]**.

### 2.4 Expectations and trust rules
Each test request carries **expectations**, not just "all pass":
| Stage | expectPass | expectFail (kind) | compareToBaseline |
|---|---|---|---|
| baseline (discover, scaffold) | – | – | records the result set |
| author-tests on base (+ stubs), run twice | characterization tests | new AC tests (`assertion` or `not-implemented`) | – |
| task | the task's locked AC tests | – | unit tests of touched projects |
| integrate | all locked AC + characterization tests | – | full suite |
| accept | AC replays | – | – |

A `TestRun` is **valid** only if all hold; otherwise the gate fails as "evidence invalid" (a safety failure):
1. Each phase's report exists in its fresh results mount, parses, and was written after the phase started.
2. Every expected ID appears with its expected outcome and `failureKind`. `skipped`, `notRun` or missing = fail.
3. Executed count ≥ discovered-in-scope count.
4. The exit code agrees with the report.

**Test IDs:** `<project or package>::<fully qualified name>(<args>)`.
- .NET: TRX per project via `LogFilePrefix` (a fixed `LogFileName` overwrites in multi-project runs); MTP `--minimum-expected-tests` is set **per module**.
- Jest: `--listTests` lists files only, so discovery = locked IDs + the baseline's result IDs.
- Playwright: `--list --reporter=json`; IDs include the project/browser name (stability UNVERIFIED).
- Unstable IDs (theories whose data changes between discoveries) are found by listing twice at baseline. Locked AC tests must have stable IDs.

**Forging controls:**
- Reporter, output path and results dir are passed on the CLI.
- The producer clears `TESTINGPLATFORM_*`, `VSTEST_*` and `NODE_OPTIONS`, and checks injected args with `dotnet msbuild -getProperty:TestingPlatformCommandLineArguments` (.NET 8 availability UNVERIFIED).
- The lock set covers tests and runner config (gate-engine §2.4).
- A diff grep catches added `process.exit`, `os._exit`, `Environment.Exit`, report-file names and patching of `expect`/`Assert`.
- The review stage reads the diff with this attack in mind.

**Honest limit:** JS reporters and MTP extensions run inside the test process, and expected IDs can be read from the locked test files. A determined forgery is possible. It needs a coordinated fake of every expected ID, outcome, count and exit code, which review and the grep are aimed at. Evidence that agents try:
- o3 reward-hacked in 30.4% of 128 RE-Bench runs but 0.7% of HCAST runs [practitioner, METR];
- Gemini CLI deleted test files in 3.4% of EvilGenie tasks [preprint].

### 2.5 Database and services
- **Shared network namespace, no bridge network.** `db` starts with `--network none` (loopback only). B2 joins with `--network container:db`, so tests reach Postgres on `localhost` and nothing else, not even the host gateway. Accept adds `app` the same way.
- Postgres with generated credentials and a **non-superuser** role: a superuser's `COPY … TO PROGRAM` runs commands (UNVERIFIED in our research, kept as a precaution).
- The core drives readiness: `pg_isready` → build → migrations → seed → tests. The connection string goes only into B (context-builder §2.6, producer env template).
- **POC support:** Postgres only (Ahsan's repos use it). Discover refuses, with a named reason:
  - SQL Server and other engines (the SQL Server Linux image is the extension point);
  - repos whose tests use Testcontainers (B never gets a container socket);
  - Windows-only targets (WPF, WinForms, `net4x`).

  *Supersedes contracts' `services.kind: testcontainers | compose` for the POC: services are provided by the core from the environment contract.*

### 2.6 Flakiness, timeouts, infra failures
- Failing **non-locked** tests are re-run once, alone, in a fresh container. A pass → `flaky` in the result and the PR, never silent.
- **Locked AC and characterization tests must pass on the first run.** A flaky pass there fails the gate, so code that makes a locked test pass half the time can't slip through.
- **Infra vs code:** when ≥5 tests fail with connection or timeout errors [EVAL threshold], the core probes after the run (`pg_isready`, then the app's health URL at accept). Only if a probe fails is the outcome `infra` (ladder rung 3). If the probes pass, it's a `code` failure: the code broke its own DB access.
- Test order is fixed; if the repo shuffles, the seed is recorded.
- A per-test hang timeout (VSTest `--blame-hang-timeout`, MTP `--timeout`, Jest/Vitest `--testTimeout`) plus a per-phase wall clock, both baseline × 3 **[EVAL]**.

### 2.7 Other producers
| Producer | When | How |
|---|---|---|
| Build | every stage | .NET build with a core targets file (`-p:CustomAfterMicrosoftCommonTargets=/factory/verify.targets`) for per-project SARIF v2.1. The default SARIF is v1, and one shared `ErrorLog` keeps only the last project [docs, issue]. Frontend: `tsc --noEmit`, `vite build` / `next build`. |
| Lint / analyzers | task, integrate | SARIF/JSON → findings with a core fingerprint: `ruleId + file + hash(flagged line ±1, normalised) + occurrence`. New = not in the baseline set. |
| Architecture | integrate | dependency-cruiser `--ignore-known` (Node); ArchUnitNET rules run as ordinary tests (.NET). Only if the repo already has them. |
| Migrations | task and integrate when a migration changed | apply on an empty DB and on the seeded DB; `dotnet ef migrations has-pending-model-changes`; generate the SQL script; squawk on the SQL (research-q Q8). |
| Diff coverage | **integrate only** | coverlet (VSTest) or Vitest v8 → Cobertura/LCov; the core intersects covered lines with the patch in TypeScript (no diff-cover or Python). |
| a11y | accept, UI tasks | `@axe-core/playwright` in the AC replay: no new serious or critical violations on touched screens. |
| Secret scan | every task commit; every commit at deliver | gitleaks on the host patch (no git in B). |
| Dependency audit | integrate | NuGet audit forced with `-p:NuGetAudit=true -p:NuGetAuditMode=all` inside R (NuGet's endpoints are on the proxy allowlist). OSV-Scanner runs **on the host** against lock files or built `*.deps.json`, using an offline DB the core refreshes. Lock files are data, so this is safe on the host. Diffed against the baseline. |
| New-dependency check | task, integrate | on the host: each new direct dependency exists in its registry and is ≥30 days old [EVAL policy]. Frontier models still invent 4.6–6.1% of package names [preprint]. |
| Mutation | off (experiment flag) | the evidence is mixed for LLM-written tests [preprint]. |

**Next.js note:** `next/font/google` fetches fonts during `next build`, which fails with no network. Discover flags it, and such repos build with fonts mocked (`NEXT_FONT_GOOGLE_MOCKED_RESPONSES`, UNVERIFIED) or are refused.

### 2.8 Accept runs
- `db` → migrations → `app` (the contract's start command) → health URL polled with a deadline → AC replays (HTTP or Playwright) in B2, all in the db's network namespace.
- **No recording proxy.** Outbound calls go to the locked fakes (WireMock.Net / MSW with `unhandled: error`), whose request logs are the evidence. The app has no outside network, so nothing can leak.
- **Linked runs (G1):** both apps start in the same namespace on different ports, and the parent run's AC replays run against both.

```ts
interface AcceptEvidence { ac: Id; kind: "http" | "ui" | "db" | "job" | "manual";
  http?: { method: string; path: string; status: number; bodySha: Sha }[];
  ui?: { screenshotSha: Sha; traceSha?: Sha; axe?: { serious: number; critical: number } };
  db?: { query: string; rowsSha: Sha; rowCount: number };
  job?: { name: string; fakeCalls: { target: string; count: number }[] };
  testId: string; passed: boolean }
```

### 2.9 Baseline
- Runs at discover, and on a greenfield scaffold commit.
- It records: timings per phase, the discovered test list (twice, for unstable IDs), known failures, lint findings with fingerprints, audit findings, VSTest/MTP mode, npm packages needing rebuild, the DB engine, Testcontainers use, Windows-only targets and `next/font/google`.
- Outcome `green | green-with-known-failures | red` (research-discovery §5); only `red` stops a run. Refusals and fixes go on the onboarding card.
- **After a rebase** (run-manager §2.10): each integrate failure that isn't in the baseline is re-run on the new base. If it fails there too, it's reported as an **upstream** failure, not blamed on the run.

### 2.10 Contracts
```ts
type VerifyStage = "baseline" | "author-tests-on-base" | "task" | "integrate" | "accept" | "deliver";
type FailureKind = "assertion" | "not-implemented" | "exception" | "timeout" | "compile" | "infra";
interface TestRun { kind: "test"; treeSha: Sha; stage: VerifyStage; runner: "vstest" | "mtp" | "jest" | "vitest" | "playwright";
  toolVersions: Record<string, string>;            // incl. image digests
  expectPass: string[]; expectFail: { id: string; kinds: FailureKind[] }[]; compareToBaseline: string[];
  discovered: string[];
  results: { id: string; outcome: "passed" | "failed" | "skipped" | "notRun"; failureKind?: FailureKind;
             durationMs: number; message?: string; frames?: string[] /* ≤5, project code */; flaky?: boolean }[];
  exitCode: number; reportShas: Sha[]; valid: boolean; invalidReason?: string;
  classification: "ok" | "code" | "infra" | "upstream" }
interface BuildRun { kind: "build"; ok: boolean; errors: { file: string; line: number; code: string; msg: string }[] }
interface LintRun { kind: "lint"; tool: string; version: string;
  findings: { ruleId: string; file: string; line: number; fingerprint: string; severity: string }[] }
interface MigrationRun { kind: "migration"; emptyOk: boolean; seededOk: boolean; pendingModelChanges: boolean; squawk: string[] }
interface AuditRun { kind: "audit"; findings: { pkg: string; version: string; advisory: string; severity: string }[];
  newDeps: { name: string; registry: string; exists: boolean; ageDays?: number }[] }
interface SecretScan { kind: "secrets"; commit: Sha; hits: { file: string; line: number; rule: string }[] }   // values never stored
interface Timing { phase: "copy" | "restore" | "build" | "test" | "lint" | "accept"; ms: number; cacheHit: boolean }
// failures.json for implement = the first 20 distinct failure signatures + new build/lint errors (context-builder §2.5)
```
*Adds to contracts' `ArtifactKind`: `test-run`, `build-run`, `lint-run`, `migration-run`, `audit-run`, `secret-scan`, `timing`; and `nextjs` to `repo-profile.packages.stack`.*

### 2.11 Runtime layer
- A `ContainerRuntime` interface over the Docker-compatible CLI: Docker Engine CE or Podman inside WSL2 (core-design §22).
- The bubblewrap fallback stays documented in research-no-docker.md but is **not built for the POC**.

---

## Part 3. Example: SHOP-412, TASK-2 verify (times illustrative)

1. The core commits TASK-2 → treeSha `a41f…` → `git archive` into a temp dir, and writes the patch.
2. Container R restores through the feed proxy. The `.nupkg` files are already in the verified cache; extraction runs into a fresh folder.
3. B1 (no network) builds with the core targets file. It stops, and the core reads the SARIF and build log: 0 new findings.
4. `db` starts; B2 joins its namespace → `pg_isready` → migrations → `--list-tests` finds 312 tests. Expectations: expectPass = AC-2, AC-3; compareToBaseline = 41 unit tests of the touched projects.
5. `dotnet test` writes TRX per project. B2 stops; the core reads the results: 40 passed, and AC-3 `OverrideFlag_Persists` failed (`assertion`).
6. AC-3 is locked, so there's no flaky re-run. The report is valid (all IDs present, exit code 1 matches). Secrets: none. New deps: none.
7. The predicates fail the gate. `failures.json` (1 signature, 14 lines) goes back to implement.

---

## Part 4. How to explain it

| Question | Answer |
|---|---|
| Why not trust the agent when it says tests pass? | Agents have been caught faking results. The factory runs the tests itself in a sealed room and checks that every expected test is in the report. |
| Can the repo's code hack the results? | It's much harder than usual: no internet during tests, the factory's files are out of reach, test files are locked, and results are read only after everything is stopped. A coordinated fake is still possible in principle, which is why review also looks for it. |
| What about private package feeds? | The factory's gatekeeper adds the password itself, so the repo's code never sees it. |
| What about flaky tests? | Ordinary tests are re-run once and flagged if they pass the second time. The tests written for your ticket must pass first time. |
| Does it need Docker Desktop? | No. Docker Engine or Podman inside WSL2, both free. |

---

## 5. Evaluate when built
- Cold and warm restore/build/test times on the .NET eval repo; per-run NuGet extraction cost; container and Postgres start time on WSL2.
- The eval repo's test mode (VSTest or MTP). Build only that runner first.
- The NuGet `.nupkg` hash check against the registry; the feed proxy with the factory CA for `dotnet` and `npm`.
- Vitest `--reporter` on the CLI vs config reporters; `dotnet msbuild -getProperty` on .NET 8; the core targets file overriding project `ErrorLog`.
- Thresholds: cluster size 5, dependency age 30 days, timeouts at baseline × 3, container caps, cache size cap.
- How many Folio3 repos hit a refusal (SQL Server, Testcontainers, Windows-only, next/font).

---

## 6. Review log (fresh-context review, 2026-09-27)

| # | Sev | Finding | Decision |
|---|---|---|---|
| 1 | crit | A writable NuGet cache could be poisoned by repo code at restore | **Fixed:** verified `.nupkg`-only cache + per-run extraction; npm cache integrity-checked, per-run writes (§2.3) |
| 2 | crit | "GET/HEAD only" unenforceable; shared-tenant hosts; DNS | **Fixed:** TLS-terminating feed proxy, URL-prefix allowlist, no DNS in R, feed config files protected (§2.3) |
| 3 | high | Private-feed tokens exposed in R | **Fixed:** the proxy adds credentials (§2.3) |
| 4 | high | Tests could rewrite reports after the runner exits; lint output unprotected | **Fixed:** stop before read; one results mount per phase; claims softened (§2.2, §2.4) |
| 5 | high | One `expected[]` couldn't express fail-on-base or baseline diffs | **Fixed:** expectPass / expectFail / compareToBaseline + failureKind (§2.4, §2.10) |
| 6 | high | A flaky re-run laundered locked tests | **Fixed:** locked tests must pass first run (§2.6) |
| 7 | high | The cluster rule sent code bugs to the infra rung | **Fixed:** infra only if a core probe fails (§2.6) |
| 8 | high | Testcontainers contradiction with contracts/Q1 | **Fixed:** refused in POC; core-provided services supersede contracts (§2.5) |
| 9 | high | Postgres only; Windows-only targets | **Fixed:** refusals named on the card; SQL Server as the extension point (§2.5) |
| 10 | high | Multi-project TRX overwrites; per-module test minimums | **Fixed:** `LogFilePrefix`, per-module `n`, ID format (§2.4) |
| 11 | med | Jest/Playwright discovery | **Fixed** (§2.4) |
| 12 | med | Missing producers | **Fixed:** build, architecture, migrations, a11y, scaffold baseline, linked accept, host OSV/new-dep; E2 out of POC (§2.7–2.9) |
| 13 | med | Internal network reaches the host gateway | **Fixed:** shared namespace, loopback only (§2.5) |
| 14 | med | Thin hardening | **Fixed** (§2.2) |
| 15 | med | Recording proxy half-specified | **Fixed:** dropped; locked fakes' logs; AcceptEvidence defined (§2.8) |
| 16 | med | Images, toolchain, cleanup unspecified | **Fixed:** digest-pinned image map, cleanup step, cache cap, no Python (§2.2, §2.3) |
| 17 | med | Stale baseline after rebase | **Fixed:** re-run new failures on the new base → `upstream` (§2.9) |
| 18 | low | Tags and accuracy | **Fixed:** RE-Bench vs HCAST, "≥" wording, UNVERIFIED tags, example order, contracts additions |
| Simplify | | Cut fallback, mutation, Betterleaks, near-name check; one runner mode; no proxy; shared namespace; TS diff coverage | **Adopted** (bubblewrap fallback documented, not built) |
