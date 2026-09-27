# AI Factory: Contracts v0 (2026-09-25)

This is the interface teammates code against. It is TypeScript types; the implementation uses zod as the single source, exported to JSON Schema for agent structured output (see reuse.md). Scope: the POC. Fields marked `// later` are the production seams from open-questions-answers.md.

Conventions:
- Every ID is stable and human-readable: `I-3`, `REQ-4`, `AC-4.2`, `TASK-2`, `ASM-1`, `Q-2`, `CONV-7`.
- Every artifact carries a header. Artifacts are files under `.factory/runs/<runId>/`.
- Any agent output that claims something about code includes `evidence[]`, which the core verifies.

```ts
// ---------- shared ----------
type Id = string;                       // "REQ-4"
type Sha = string;                      // sha256 hex
interface Evidence { path: string; lineStart: number; lineEnd: number; quote: string } // core checks quote == file[lines]
interface ArtifactHeader {
  kind: ArtifactKind; schemaVersion: 1; runId: string;
  producedBy: { stage: StageName; agent?: AgentId; model?: string; effort?: string };
  inputsHash: Sha;                      // hash of all inputs → staleness + resume
  createdAt: string;
}
type Risk = "low" | "medium" | "high";          // effective = max(rules, intake model, impact); model may only raise
type Complexity = "S" | "M" | "L";
```

## 1. Stage contract

```ts
type StageName =
  | "discover" | "intake" | "ground" | "clarify" | "specify" | "design"
  | "impact" | "plan" | "approve" | "author-tests" | "implement"
  | "verify" | "review" | "deliver" | "scaffold" | "decide-architecture"
  | "breakdown" | "estimate" | "prototype" | "integrate" | "accept";

interface StageDef {                     // lives in modes/*.yaml, validated by zod
  name: StageName;
  exec: "deterministic" | "agent" | "human" | "mixed";
  inputs: ArtifactKind[];                // must exist and be valid
  output: ArtifactKind;
  when?: string;                         // e.g. "intent.touchesUi" (design only)
  agentRole?: AgentRole;                 // → tier table (workflow-design §4)
  tools?: string[];                      // fixed per stage; read-only stages get none that write
  budget: { maxInputTokens: number; maxTurns?: number; maxUsd?: number; wallClockSec: number };
  gate: GateDef[];
  retry: { max: number; escalation: EscalationStep[] };
}

type AgentRole = "classifier" | "summariser" | "clarifier" | "spec-drafter" | "critic"
  | "designer" | "planner" | "test-author" | "implementer" | "reviewer" | "estimator";

type EscalationStep = "reask-with-error" | "raise-effort" | "next-tier" | "other-vendor" | "human";

interface GateDef {
  id: string;                            // "spec.every-req-has-ac"
  kind: "check" | "human";
  blocking: boolean;
  check?: string;                        // name of a deterministic check function
  humanWhen?: string;                    // condition, e.g. "risk=='high' || source=='client-brief'"
}

// SUPERSEDED by gate-engine.md v2 §2.1 (one GateDef shape: id, after, reads, predicate, waiver;
// GateResult: gateId, passed, details, failures?, inputsHash, treeSha?, waiver? {human, reason, boundTo}).
// Producers (sealed container, record tool versions) are separate from pure predicates.

// Core ↔ stage runner
interface StageRunner {
  run(ctx: StageContext): Promise<StageOutcome>;
}
interface StageContext {
  run: RunState; stage: StageDef; inputs: Record<ArtifactKind, unknown>;
  contextPack: ContextPack;              // built by core, measured against budget
  agent?: AgentAdapter;                  // chosen by Decider
}
type StageOutcome =
  | { status: "ok"; artifact: unknown; gates: GateResult[]; usage: Usage }
  | { status: "retry"; reason: string; failures?: Failure[]; usage: Usage }
  | { status: "escalate"; reason: string; evidence: string[]; usage: Usage }
  | { status: "await-human"; card: HumanCard; usage: Usage };
```

### Agent adapter (Claude Agent SDK / Codex SDK / Cursor CLI)

```ts
interface AgentAdapter {
  id: AgentId;                           // "claude-code" | "codex" | "cursor" | "local:<name>"
  run(req: AgentRequest): Promise<AgentResult>;
}
interface AgentRequest {
  workdir: string;                       // the run's git worktree
  systemPrefix: string;                  // stable, cacheable (stage template + conventions)
  task: string;                          // run-specific tail
  contextFiles: string[];                // paths the agent may read first
  allowedTools: string[];
  outputSchema: JSONSchema;              // structured output required
  model: string; effort: "low" | "medium" | "high" | "xhigh";
  limits: { maxTurns: number; maxUsd?: number; wallClockSec: number };
  hooks?: { afterEdit?: string };        // lint-in-loop command
}
interface AgentResult { output: unknown; exit: "ok" | "schema-error" | "timeout" | "budget" | "error";
  usage: Usage; transcriptPath?: string /* deleted after run by policy */ }
interface Usage { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number;
  turns: number; wallMs: number; estUsd: number }
```

### Run state (files; resume by replay)

```ts
interface RunState {
  runId: string; mode: "brownfield" | "greenfield" | "estimate";
  repo: { path: string; baseCommit: string; branch: string; worktree: string };
  projectConfig: string;                 // path to factory.project.yaml
  status: "running" | "awaiting-human" | "escalated" | "failed" | "delivered";
  currentStage: StageName;
  completed: { stage: StageName; artifact: string; inputsHash: Sha }[];
  risk: Risk; complexity?: Complexity;   // complexity set after plan
  changes: string[];                     // change-NN.md inputs (mid-run requirement changes)
  costUsd: number; capUsd: number;
}
```
Resume rule: when replaying the event log, a completed stage whose `inputsHash` is unchanged is skipped. Sinks look up existing PRs or issues before creating one.

## 2. Artifact schemas

```ts
type ArtifactKind = "repo-profile" | "conventions" | "baseline" | "intent" | "current-behaviour"
  | "questions" | "spec" | "design" | "impact" | "plan" | "approval" | "acceptance-tests"
  | "failures" | "verification" | "review" | "delivery" | "adr" | "work-breakdown" | "estimate"
  | "acceptance-evidence" | "evidence-manifest";
```

### repo-profile (≤ ~15K tokens)
```ts
interface RepoProfile { header: ArtifactHeader;
  packages: { path: string; stack: "dotnet" | "node-express" | "react-vite"; toolchain: Record<string,string> }[];
  commands: { restore: string; build: string; test: string; lint?: string; format?: string; source: "ci" | "stackpack" | "readme" }[];
  baseline: "green" | "green-with-known-failures" | "red"; knownFailures: string[];
  modules: { path: string; purpose: string }[];      // one line each
  repoMap: string;                                   // ranked tree-sitter map, ≤4k tokens
  codeIntel: "repomap" | "graphify";
  docs: { path: string; kind: string; conformance?: number; contradicted: string[] }[];
  noGo: string[];                                    // globs from the onboarding card
  profileCommit: string;
}
```

### conventions
```ts
interface Convention { id: Id; appliesTo: string[] /*globs*/; rule: string /*one line*/;
  exemplar: string /*path*/; check?: { tool: "eslint" | "roslyn" | "grep" | "depcruise" | "archunit"; ref: string };
  evidence: { matching: number; total: number; recentMatching: number; recentTotal: number };
  status: "confirmed" | "mixed" | "candidate"; source: "tool-config" | "mined" | "human" | "stackpack";
  stats?: { fired: number; violatedByHumans: number; waived: number } }   // drift, later
```

### intent
```ts
interface Intent { header: ArtifactHeader;
  source: "ticket" | "brief" | "cli"; sourceRef?: string;
  spans: { id: Id /*I-n*/; text: string }[];         // quoted, untrusted
  changeClass: "bugfix" | "feature" | "refactor" | "migration" | "config";
  risk: Risk; riskTags: string[];                    // auth, payments, pii, migration, public-api
  rigor: "light" | "full"; touchesUi: boolean;
}
```

### questions and assumptions
```ts
interface Questions { header: ArtifactHeader;
  questions: { id: Id; category: string; text: string; options: string[]; recommended: string;
    impact: 1|2|3; uncertainty: 1|2|3; answer?: string; answeredBy?: string }[];   // max 5 asked
  assumptions: { id: Id /*ASM-n*/; text: string; risk: Risk; fromSpan: Id[] }[];
  conflicts: string[];
}
```

### spec (EARS + Given/When/Then + deltas)
```ts
interface Spec { header: ArtifactHeader;
  requirements: {
    id: Id; ears: string;                            // "When <trigger>, the <system> shall <response>"
    op: "ADDED" | "MODIFIED" | "REMOVED";            // brownfield delta
    anchors?: Evidence[];                            // required for MODIFIED/REMOVED
    sources: Id[];                                   // intent spans / answers
    acceptance: { id: Id; given: string; when: string; then: string; level: "api" | "job" | "ui" | "manual" }[];  // black-box only (A3, D1)
    stability?: number;                              // drafts containing it / 3
  }[];
  nfrs: { id: Id; text: string; metric: string }[];
  outOfScope: string[]; assumptions: Id[];
  lint: GateResult[]; critic: { finding: string; reqId?: Id; severity: "blocking" | "minor" }[];
  roundTrip: { droppedSpans: Id[]; inventedCapabilities: string[] };
}
```

### design (only for UI changes)
```ts
interface Design { header: ArtifactHeader;
  flow: string;                                      // Mermaid
  screens: { id: Id; route: string; file: string; reqs: Id[] }[];   // React mock
  mapping: { unmappedReqs: Id[]; orphanScreens: Id[] };             // both must be empty
  figmaUrl?: string;                                 // optional sink, later
}
```

### impact and plan
```ts
interface Impact { header: ArtifactHeader;
  touched: { path: string; reason: string; evidence: Evidence[]; edgeKind: "extracted" | "inferred" }[];
  consumers: string[]; missingTests: string[];
  nonCode: ("migration" | "ci" | "infra" | "config")[];
  risk: Risk;
}
interface Plan { header: ArtifactHeader;
  tasks: { id: Id; title: string; reqs: Id[]; fileScope: string[];
    exemplars: string[]; conventions: Id[];          // ≤15 rules injected
    dependsOn: Id[]; plannedLoc: number; newFileKind?: boolean }[];
  options: { id: Id; summary: string; simplest: boolean; tradeoffs: string }[];   // ≥2 (F)
  chosen: Id; adr: string;                           // ≤5 lines
  complexity: Complexity;                            // computed by core from tasks + impact
  protectedPathsDeclared: string[];                  // e.g. a config edit the plan intends
}
```

### approval card (the one human gate)
```ts
interface Approval { header: ArtifactHeader;
  auto: boolean; reason: string;                     // why auto-proceeded or why asked
  card?: { coverage: { span: Id; reqs: Id[] }[]; assumptions: Id[]; unstable: Id[];
           criticFindings: number; mockUrl?: string; plannedFiles: number; risk: Risk };
  decision?: "approved" | "rejected" | "edited"; by?: string; edits?: string;
}
```

### acceptance tests (the lock)
```ts
interface AcceptanceTests { header: ArtifactHeader;
  tests: { acId: Id; file: string; name: string; failsOnBase: boolean; failureKind: "assertion" | "compile" | "other" }[];
  characterisation: { target: string /*touched file/behaviour NOT being changed*/; file: string; passesOnBase: boolean }[];   // A4
  lock: { file: string; sha: Sha }[];
  unlocks: { acId: Id; approvedBy: string; reason: "requirement-change" | "test-defect"; note: string }[];   // A5
}
```
Gate rule: every test has `failsOnBase=true` and `failureKind="assertion"`. Every lock hash must be unchanged at verify.

### failures (the verify → implement feedback, compact)
```ts
interface Failures { header: ArtifactHeader; attempt: number;
  items: { check: string; testId?: string; message: string; frames: string[] /*≤5*/; location?: string }[];
  priorSignatures: string[];                         // loop detection
}
```

### verification
```ts
interface Verification { header: ArtifactHeader;
  gates: GateResult[];                               // hygiene, escape-hatches, config-integrity, tests,
                                                     // architecture, size, diff-coverage, security, a11y
  newFindings: { tool: string; rule: string; file: string; line: number }[];
  locks: "intact" | "violated";
  newDependencies: { name: string; version: string; registryOk: boolean }[];
}
```

### review
```ts
interface Review { header: ArtifactHeader;
  findings: { id: Id; category: "correctness" | "spec-mismatch" | "error-handling" | "security" | "reuse" | "convention-intent";
    file: string; line: number; text: string; confidence: number; severity: "critical" | "high" | "medium" | "low" }[];   // blocking derived by code (gate-engine v2)
}
```

### delivery
```ts
interface Delivery { header: ArtifactHeader;
  forge: "bitbucket" | "github"; prUrl: string; draft: boolean;
  includedTasks: Id[]; excludedTasks: Id[];          // partial delivery
  trace: { req: Id; acs: Id[]; tests: string[]; tasks: Id[]; commits: string[] }[];
  costUsd: number;
}
```

### estimate mode
```ts
interface WorkBreakdown { header: ArtifactHeader;
  disciplines: { name: "Backend" | "Frontend" | "Mobile" | "Admin" | "QA" | "Design" | "PM" | "PDM";
    modules: { name: string; reqs: Id[];
      tasks: { name: string; minH: number; maxH: number; comment: string;
               leverage: "high" | "medium" | "low"; assumptions: Id[] }[] }[] }[];
}
interface Estimate { header: ArtifactHeader;    // every number below is computed by code
  rows: { discipline: string; minH: number; maxH: number; avgH: number; aiMinH: number; aiMaxH: number }[];
  buffers: { bugFix: [number, number]; revisions: [number, number] };
  ratiosUsed: { discipline: string; ratio: number; source: string }[];
  totals: { minH: number; maxH: number; aiMinH: number; aiMaxH: number };
  cost: { rate: number; min: number; max: number }[];
  leverageFactors: { high: number; medium: number; low: number; label: "assumption" };
  xlsxPath: string;
}
```

## 3. Config (layered: org → client policy → project → run)

```ts
interface ProjectConfig {
  project: string; policy: string;
  stacks: string[];
  agents: { default: AgentId; byRole?: Partial<Record<AgentRole, AgentId>> };
  tiers: Record<"T0"|"T1"|"T2"|"T3"|"T4", string[]>;   // allowed models only
  sources?: Record<string, unknown>; tools?: Partial<Record<StageName, string[]>>;
  sinks?: { spec?: unknown; tasks?: unknown; code: { forge: "bitbucket" | "github"; repo: string; auth: string /*ref*/ } };
  gates: { approvePlan: string[]; unlockTests: string[]; waivers: string[] };
  environment: string;                               // path to .factory/environment.yaml
  budget: { perRunUsd: number };
  billing?: { mode: "A" | "B" | "C" };               // later
  concurrency?: { maxRuns: number };                 // later (POC: 1)
  notify?: { kind: "none" | "slack" | "teams"; target?: string };   // later
}
interface Policy {                                   // security settings only get stricter down the layers
  allowedAgents: AgentId[]; allowedModels: string[]; localOnly: boolean;
  protectedPaths: string[]; escapeHatchAllowlist: string[];
  maxDiffLines: number; retryBudget: number; network: "none" | "allowlist";
  dataRetentionDays?: number;                        // later
}
interface Environment {                              // .factory/environment.yaml
  services: { name: string; kind: "testcontainers" | "compose"; image?: string }[];   // E1
  fakes: { kind: "msw" | "wiremock"; config: string }[];                              // E0
  envFile?: string;                                  // POC: local file; later: secrets provider
  secrets?: { provider: "env-file" | "1password" | "infisical"; refs: string[] };
  smoke?: { command: string };                       // E2, optional
  identities?: { role: string; user: string; token?: string /*ref*/ }[];   // D6, created by core in throwaway DB
  entryPoints?: { kind: "http" | "job" | "queue"; ref: string }[];         // D1, from stack pack + discover
  referenceDb?: { conn: string /*ref*/; access: "read-only" };             // D9, discover only
}
```

## 4. Event log (`events.jsonl`: metadata and hashes only, never code)

```ts
interface Event { ts: string; runId: string; stage: StageName; seq: number;
  type: "stage-start" | "agent-call" | "gate" | "artifact" | "retry" | "escalate"
      | "human-card" | "human-decision" | "decision" | "change-received" | "sink" | "stage-end";
  artifactSha?: Sha; gate?: GateResult;
  decision?: { question: string; choice: string; backend: "rules" | "jev" | "llm"; features: Record<string, number|string>; confidence?: number };
  usage?: Usage; agent?: AgentId; model?: string; effort?: string;
  failureSignature?: string;
}
```

## 5. Deterministic checks the core owns (POC list)

- **spec:** every REQ has an AC; EARS pattern matches; vague-word lexicon; NFRs have a metric; every intent span is covered; MODIFIED/REMOVED anchors resolve; size budget per change class.
- **design:** no unmapped REQs and no orphan screens.
- **plan:** every REQ is covered; every task has a file scope and an exemplar; rules per task ≤ 15; no protected path unless declared.
- **evidence:** each quote matches the file at the given lines.
- **tests:** each test fails on base with an assertion failure; lock hashes are unchanged.
- **verify:** no new findings versus baseline on changed lines; no escape hatches; config integrity; no skipped or deleted tests; architecture; size and complexity; diff coverage; secrets; new dependencies exist in the registry.
- **loop detection:** the same tool+args hash 3 times; the same failure signature twice; no diff change between retries.
- **estimate:** all arithmetic.

## 6. Audit additions (2026-09-25, see plan-audit.md)

```ts
interface AcceptanceEvidence { header: ArtifactHeader;      // stage: accept
  items: { acId: Id; kind: "http" | "job" | "outbound" | "db" | "screenshot" | "manual";
           file: string; sha: Sha; passed: boolean }[];     // gate: every AC has >=1 item
}
interface EvidenceManifest { header: ArtifactHeader;        // written by core at deliver from the ledger
  artifacts: { kind: ArtifactKind; path: string; sha: Sha }[];
  locks: { file: string; sha: Sha }[];
  approvals: { gate: string; artifactSha: Sha; osUser: string; gitIdentity: string; riskNote: string; at: string }[];
  gatedTreeSha: Sha; waivers: { gateId: string; human: string; reason: string; boundTo: Sha }[];
  unlocks: { what: string; human: string; reason: string; boundTo: Sha }[];
  configFingerprint: Sha; versions: Record<string, string>;  // agents, tools, stack packs
}
```
- Ledger of record: `~/.factory/ledger/<runId>/` (outside the worktree). `.factory/**` is protected in the worktree.
- Change-class gates before implement: see core-design §13 A3.

## 7. Hybrid harness runners (2026-09-25, core-design §14)

```ts
type Runner = "llm" | "agent" | "deterministic";          // StageDef gains: runner: Runner
interface LlmRunner {                                      // own thin loop, read-only tools only
  run(req: LlmRequest): Promise<AgentResult>;               // same result/Usage shape as adapters
}
interface LlmRequest {
  provider: "anthropic" | "bedrock" | "vertex" | "openai" | "openai-compatible";
  baseUrl?: string;                                         // Ollama / vLLM / LM Studio
  model: string; effort?: "low" | "medium" | "high";
  auth: string;                                             // credential reference, never a value
  systemPrefix: string; task: string; contextFiles: string[];
  tools: ("read_file" | "search" | "repo_map" | "graph_query" | `mcp:${string}`)[];   // no write/shell, enforced
  outputSchema: JSONSchema; maxReasks: 2;
  limits: { maxTurns: number; maxInputTokens: number; wallClockSec: number };
}
```
Config check: every stage must resolve to a runner with a usable credential route; subscription-only routes are valid only for `runner: "agent"`.

## 8. Run manager (2026-09-26, run-manager.md v2; supersedes §1 RunState and §4 Event)

```ts
type RunStatus = "created" | "running" | "waiting" | "paused" | "parked" | "delivered"
  | { closed: "merged" | "pr-closed" | "not-reproduced" | "stopped" };
interface LedgerEvent {
  seq: number; ts: string; runId: string; epoch: number;   // epoch = execution-lock fencing token
  type: EventType; key?: string;                           // "stage/task/attempt"
  inputsHash?: Sha; treeSha?: Sha; outputs?: Sha[]; data?: Record<string, unknown>;
}
type EventType =
  | "run.created" | "run.resumed" | "run.pause-requested" | "run.paused" | "run.parked"
  | "run.stop-requested" | "run.stopped" | "run.delivered" | "run.closed"
  | "step.started" | "step.completed" | "step.failed" | "step.interrupted"
  | "gate.result" | "human.requested" | "human.decided" | "change.received"
  | "sink.intent" | "sink.done" | "usage"
  | "workspace.created" | "workspace.removed" | "container.started" | "container.removed"
  | "ledger.repaired" | "version.changed";
// inputsHash = hash(input artifact shas, stage def, prompt template version, model [, taskStartSha for coding steps])
// Versions are recorded in run.created, not hashed. Usage events carry OTel gen_ai.* field names.
```
RunState is derived by replaying `~/.factory/ledger/<runId>/events.jsonl`; it is never stored.

## 9. Context builder (2026-09-26, context-builder.md v2; supersedes §3 contextPack/contextFiles wording)

```ts
interface PackRecipe { stage: StageName; class: "read-small" | "read-large" | "agent";
  budgetTokens: number; recapKey: string; sections: SectionSpec[] }
interface SectionSpec { id: string;
  source: "template" | "stackpack" | "profile" | "rules" | "artifact" | "doc" | "image" | "pointers" | "feedback" | "task" | "recap";
  ref?: string; trust: "trusted" | "derived" | "untrusted"; placement: "system" | "user";
  trimmable?: "pointers-tail" | "map-depth" }
interface ContextPack { system: string; user: string; images: Sha[];
  pointers: { path: string; reason: string }[]; tools: string[];
  manifest: { stage: StageName; model: string; recipeVersion: string;
    sections: { id: string; tokens: number; trimmed: boolean; trust: string }[];
    packTokens: number; budgetTokens: number; countMethod: "proxy" | "vendor";
    fullRequestTokens?: number; redactions: number; packSha: Sha } }
// AgentRequest.systemPrefix = template + stack-pack rules + profile slice; repo conventions go in `task`.
// AgentRequest.contextFiles / LlmRequest.contextFiles = pointers[].path. step.started.data.packSha records the pack.
```

## 10. Verify runner (2026-09-27, verify-runner.md v2 §2.10)
Adds ArtifactKind `test-run | build-run | lint-run | migration-run | audit-run | secret-scan | timing` and `AcceptEvidence`; `repo-profile.packages.stack` gains `nextjs`. TestRun carries `expectPass`, `expectFail[{id, kinds: FailureKind[]}]`, `compareToBaseline`, `failureKind` per result, `classification: ok|code|infra|upstream`. Supersedes `services.kind: testcontainers|compose` for the POC: the core provides services from the environment contract.
