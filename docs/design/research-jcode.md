# jcode: Evaluation for AI Factory (2026-09-25)

Repo: https://github.com/1jehuang/jcode

Sources:
- the repo README;
- docs/SAFETY_SYSTEM.md;
- the SDK page https://jcode.sh/sdk;
- the releases page;
- HN thread https://news.ycombinator.com/item?id=49733726.

The GitHub contributor and commit pages were blocked by robots.txt, so the maintainer count and commit recency are **UNVERIFIED**.

## What it is

An open-source coding-agent **harness**, in the same category as Claude Code, Codex CLI, OpenCode and pi. It is written in Rust and licensed MIT. It pitches itself as "the most RAM efficient harness".

| Area | Facts |
|---|---|
| Popularity | 19.7k stars, 2.3k forks, 7,472 commits, 460 open issues, 20 open PRs |
| Releases | Very fast, often several per day (6 on Jul 30). Latest seen is v0.65.0 on Aug 2. **Pre-1.0**, so expect churn |
| Providers | Claude, OpenAI, Gemini, Copilot, Azure, OpenRouter and 20+ more. **Local: Ollama, LM Studio, vLLM, any OpenAI-compatible endpoint**, with streaming and function/tool calling |
| Programmatic use | `jcode run "…"` (one-shot) and `jcode serve`/`connect`. **TypeScript SDK `@1jehuang/jcode-sdk`, stated GA with a stable protocol v1.** `runStructured()` validates output against a JSON Schema with Ajv and bounded corrective retries (default 2). Model and effort are set per session. Permission events can be handled in code |
| MCP | Yes, Claude-Code-compatible `mcp.json` (global or project) |
| Other features | Semantic vector memory across sessions, multi-agent "swarm" in one repo, built-in Firefox browser automation, a "self-dev" mode that edits its own source, session resume from Codex/Claude Code/OpenCode/pi |
| Safety model | Two tiers: local reversible actions (read, git, **run tests and commands**) are auto-allowed; anything outbound (push, post, deploy) needs permission. Headless runs queue permission requests. **No sandbox described.** File access in the SDK is limited to the session's working directory |
| Performance claims | 27.8 MB RAM baseline, 14 ms boot, ~9.9 MB per extra session. **All self-reported** |
| Community | HN users call it better than OpenCode and say it gives the best results in "Ship Harness Bench" thanks to browser integration. **Anecdotal, no numbers** |
| Missing or unclear | No documented budget or turn limits in the SDK. No telemetry statement. No ACP mention. Bus factor unknown (repo is under a personal account) |

## Does it fill a gap in our design?

**Yes, one real gap: a proper harness for local models.** The current plan for Ollama is awkward: Codex's `--oss` mode, or Claude Code pointed at Ollama through LiteLLM. Neither is built around local models. jcode offers:
- native Ollama, vLLM and LM Studio support;
- a TypeScript SDK (our core is TypeScript);
- schema-validated output, which matches our contracts.

It is also relevant to cost. The HN thread on harness overhead reports that third-party harnesses beat Claude Code and Codex on cost with the same model, mostly because of their smaller system prompts. This matches the Databricks finding already in our research that the harness moves cost by about 2x. So jcode could also be a cheaper harness for hosted models (via API key). **That's a hypothesis to test in the eval, not a fact.**

## What conflicts with our design

| jcode feature | Our rule | Action |
|---|---|---|
| Cross-session vector memory | A fresh context per task; no transcripts carried over (context-engineering rules) | Turn memory off for factory runs |
| Swarm (multi-agent in one repo) | The run manager owns concurrency and file scope | Turn it off |
| Self-dev mode | — | Never use it |
| Auto-allows running local commands, no sandbox | Agents run in a worktree/container without network | Run it inside our sandbox anyway |
| Pre-1.0, several releases a day | Pinned, conformance-tested adapters | Pin the exact version; run adapter tests before upgrading |
| No budget or turn caps documented | Core enforces wall-clock and token ceilings externally | Enforce outside jcode, as we already do for Codex |

## Recommendation

**ADOPT as an optional adapter (`jcode`), mainly for the local tier (T0), behind our `AgentAdapter` interface. It is not core.**
- It becomes the default route for commodity tasks on Ollama, which is what Ahsan asked for.
- Confirm it with a bake-off on the eval set: the same commodity and S-size tasks through jcode+Ollama vs Codex `--oss`+Ollama, compared on pass rate, tool-call errors and wall time.
- Secondary experiment: jcode with a hosted model vs Claude Code on the same tasks, compared on cost per accepted task.
- If the bus factor or churn becomes a problem, swapping it out costs one adapter, nothing else.

## Commodity tasks on Ollama: what "commodity" means (from research-model-routing.md)

- **Good fit (outputs checked by code):**
  - intake classification;
  - summaries of modules and docs;
  - doc-claim extraction;
  - commit and PR text;
  - changelogs;
  - naming checks;
  - estimate leverage tags (code validates the label set).
- **Experimental:** implement on S tasks only, with lint in the loop and escalation on the first tool-call parse error.
- **Not local:** clarify, specify, critic, plan, author-tests, review. Small models under-ask and miss review issues.

"Zero cost" isn't quite true. It costs hardware, it runs slower, and failures escalate to paid models anyway. Log it like any other tier.

Setup requirements:
- ≥64K context. Ollama's default is 4K on GPUs under 24 GB, so set `num_ctx` explicitly.
- Prefer vLLM over Ollama for tool-heavy stages, because Ollama has open tool-call bugs.
- A 24–35B coding model: Qwen3.6-35B-A3B or Devstral Small 2.

## Integration plan (2026-09-25)

**Role:** jcode is one agent adapter among several (claude-code, codex, jcode). The router picks the adapter per stage; jcode is never core.

| Use | Stages | Model behind jcode | Status |
|---|---|---|---|
| 1. Local commodity worker (primary) | intake, discover summaries, doc-claim extraction, commit/PR text, changelog, estimate leverage tags | Ollama/vLLM (Qwen3.6-27B/35B, gpt-oss-120b), ≥64K ctx | adopt after bake-off A |
| 2. Cheap harness for hosted models (candidate) | implement S/M, maybe author-tests | Claude/OpenAI via API key | only if bake-off C shows lower cost per accepted task at equal acceptance (HarnessTax: harness moves cost up to 5x, accuracy ±2–5%) |
| 3. Local small-task implementer (experiment) | implement S only | local | bake-off B; escalate on first tool-call error |
| Not used | clarify, specify, critic, plan, review | — | strongest models + independence rules |
| Not used | browser automation | — | UI checks stay deterministic Playwright |

**Adapter (via `@1jehuang/jcode-sdk`, pinned version):**
- createSession(workdir = run worktree, provider, model) → setReasoningEffort(stage effort)
- runStructured(prompt, JSON Schema from contracts.md) → output validated again by core (evidence, schema)
- events() → map token usage/tool calls into events.jsonl `Usage`
- permission_request → allow only local actions inside the sandbox; deny anything outbound
- core enforces wall clock + token ceiling (SDK has no documented budget caps)

**Settings for factory runs:** memory off, swarm off, self-dev off, project-local mcp.json only with the stage's allowed MCP servers, run inside the factory's sandbox container, transcripts deleted after run.

**Bake-offs on the .NET eval set (decide by cost per accepted task, acceptance must not drop):**
- A: commodity stages, jcode+Ollama vs Codex `--oss`+Ollama (pass rate vs code checks, tool-call errors, wall time)
- B: S implement tasks, jcode+local vs Claude Code+T2 (acceptance, escalation rate, cost)
- C: M implement tasks, jcode+Claude API vs Claude Code, same model (HarnessTax replication)

**Exit plan:** if jcode churns or stalls, swap the adapter for Pi or OpenCode (OpenCode read hidden tests in harness-bench, so verify always runs in a separate container regardless).
