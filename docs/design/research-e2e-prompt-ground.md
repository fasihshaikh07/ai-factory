# Research: AI-driven browser testing, prompt-first brownfield runs, and a frontier model for grounding (2026-09-27)

## Summary

**1. A local AI model clicking through the app with Playwright MCP to do end-to-end browser testing: reject as proposed. Adopt a narrow version.**
An AI that drives a browser live gives a different result from one run to the next. The best published AI "test agents" reach the right pass/fail verdict only about 60% of the time. Small local models are weaker still: they often chain tool calls wrongly, and some say "done" when they aren't. A result like that can't be locked in advance or trusted as a gate. Our current approach already gets the useful part. An AI writes the Playwright test once, from the agreed acceptance criteria. We prove it fails on the old code, lock it, and then the test lab replays it exactly, with no model cost per run. "Free" also doesn't hold up. The page descriptions the browser tool sends back are large: one busy screen can take 12,000 tokens, and a session builds up to tens of thousands. That goes past what a local model gets from us, so it would spill over to a paid model. On a typical Windows laptop each step also takes seconds to minutes, so every run and every retry costs real time. What we should adopt instead:
- The test lab takes a plain, non-AI text outline of the old app's screens and of the design mock. The test-writing AI gets that outline, so its selectors match real button and field names. This fixes brittle selectors without an AI in the gate.
- An optional, off-by-default exploratory "smoke walk" by a hosted model after acceptance. It is advisory only, so it can raise findings but never pass or fail a run.
- When a locked UI test breaks on a selector, an AI may suggest a fix. The suggestion goes on the existing card where a human decides whether to unlock the test.

**2. Brownfield runs that start mainly from a typed prompt, with a second round of clarifying questions: adopt with changes.**
Starting from a prompt suits the demo and how people actually work. It needs four guard rails:
- **Handle the typed prompt like outside text.** Operators often paste in client emails or chat. Research this year showed that attacks hidden in text an AI has asked for succeed far more often (from about 2% to about 34% on some models). Only the read-only steps see the raw prompt. We still record who typed it.
- **Keep the record without Jira.** Store the exact prompt, its fingerprint, who typed it and when, and every answer. Quote the prompt in the pull request. An optional free-text reference can be added, such as a chat link.
- **Keep the second round small.** Ask it only when the answers themselves open a new high-impact gap, and cap it at 3 questions (8 in total). Low-risk runs turn leftover gaps into written assumptions instead of asking. Research shows that asking more does not raise accuracy in step. The best systems ask about one round's worth, and goal questions lose their value if asked late.
- **Show the prompt word for word on the approval card.** A typed prompt has had less review than a groomed ticket.

**3. The grounding step (finding the real files and functions the change touches) on Opus 5.5 instead of Sonnet 5: adopt for medium- and high-risk work; keep Sonnet for low-risk bugfixes until we measure.**
Missing a relevant file is the one grounding error our checks can't catch. A made-up file is caught; a forgotten one is not. Published results show that stronger models do find more of the right code: the gaps are largest between model tiers and at the level of individual functions. But the results also show that how the search is organised often matters more than the model, and nobody has published a direct Opus 5.5 vs Sonnet 5 comparison. At today's list prices the switch adds about $0.20–0.50 per run. Opus costs twice as much per fresh input and output token, but reading cached text costs the same on both. That is small for a feature run. For a $3 bugfix it is 7–17% of the budget, and a bugfix run is already estimated at roughly $2–5 in our model, so it could push some runs over the cap. We should measure recall on our own past fixes, where we already know which files changed, before deciding for bugfixes.

---

## 1. Playwright MCP driven by a local LLM for end-to-end browser testing

### 1a. How Playwright MCP works, and how reliable small models are

**Mechanics (docs).**
- Playwright MCP returns **accessibility snapshots**: a structured tree of accessible elements, each with a ref (`e5`) that tools act on. It does not send screenshots by default. There is an optional **vision mode** (`--caps=vision`) that acts on coordinates from screenshots. Source: https://playwright.dev/mcp/snapshots (current docs, read 2026-09-27); https://playwright.dev/mcp/vision-mode.
- The tool definitions alone cost 3.4K–6.2K tokens per session (24 tools). "What the tools return dwarfs what they cost to register". Each `browser_snapshot` returns the full tree. Microsoft's README recommends the **Playwright CLI rather than MCP for coding agents**, to keep large trees out of context. `browser_run_code_unsafe` (arbitrary JS in the server process) is on by default. Source: https://www.oodle.ai/guides/mcp/playwright (verified 2026-09-01).
- Measured snapshot sizes: login form ~3.8K tokens, data dashboard ~12K, Hacker News ~9–10K, a Salesforce page 114K. A realistic session reached ~25K tokens by step 4 and ~89K by step 8. Agents started referring to elements that no longer existed at 60–90K. MCP used 114K tokens per test against 27K for the CLI. Source: https://lite.ego.app/article/playwright-mcp-token-problem (2026-08-12; practitioner, UNVERIFIED measurements).
- Playwright itself added AI helpers. v1.56 added **Test Agents** (planner → generator → healer), which *generate test files* and repair them. v1.59 added a screencast API, "agentic video receipts", and `browser.bind()` to share a browser with playwright-cli and MCP. Source: https://playwright.dev/docs/release-notes (read 2026-09-27). The vendor's own direction is to have **the AI write test scripts**, not to be the test.

**Reliability of browser agents (benchmarks).**
| Evidence | Numbers | Source |
|---|---|---|
| LLM agents as *testers*: 113 manual test cases on 3 web apps, with the agent judging pass or fail | Best agent (PinATA) ≈ **60% correct verdicts**, specificity up to 94%. Authors: not reliable enough for maintenance-free test automation | https://arxiv.org/abs/2504.01495 (2025-04; ACM PACMSE 2025) |
| WebArena-Verified leaderboard | Top 69% (Muse Spark 1.1). **Qwen3.8-27B 64.8%** (open weights). All rows are provider self-reports, none independent | https://benchlm.ai/benchmarks/webarena-verified (updated 2026-09-25) |
| "Grow the Harness" paper | gpt-oss-20b 44.7%, gpt-oss-120b 45.3%, qwen3.5-4b 45.3% on WebArena-Verified. A critique argues the flat result means deterministic site-specific resolvers do the work (1.8 LLM calls per task) | arXiv 2609.26760, critique at https://github.com/jjakimoto/research-issues/issues/1705 (2026-09-23). **UNVERIFIED**: paper not read |
| BrowserArena (real-world tasks) | DeepSeek-R1 "marks the task as completed at the highest rate" despite not seeing the banner blocking it, which is a **false success claim**. VLM judges agreed with humans only 48–68% | https://arxiv.org/html/2510.02418v2 (2025-10) |
| REBUG (reproduce web bug reports live) | GPT-5 mini / Haiku 4.5 / Gemini 2.5 Flash: **~50% reproduction success**, 87% of individual actions executed | https://arxiv.org/html/2608.03598 (2026-08) |
| Local tool calling, 13 models on 128 GB hardware | gpt-oss-20b 85% overall but **2/8 on multi-tool** tasks; Qwen3 8B 85%, 2/8; Qwen3.5 4B 97.5%, 7/8 | https://www.jdhodges.com/blog/local-llms-on-tool-calling-2026-pt1-local-lm/ (2026-03; practitioner) |
| Qwen3 Coder on underspecified SWE tasks | 100% false-negative rate at detecting missing information | https://arxiv.org/html/2502.13069 (v3 2026-02) |

**Reading:** even the best systems finish roughly 1 in 3 web tasks wrongly. Multi-step tool chaining is exactly where small local models fail most. No published benchmark measures Playwright MCP with a local model on a real app (**not found**).

### 1b. Determinism and trust: a locked test, or only advisory?

It can only be advisory. Four reasons:
1. **Our lock is meaningful only because the test is fixed code.** Hashing a prompt does not fix the behaviour: sampling, Ollama and model versions, and page timing all change the path the model takes. The "fails on base twice, then locked" proof would not carry over to later runs.
2. **A pass would be the model's claim.** Our gates never accept a model's word. A browser agent's "AC passed" is exactly that, and false completion claims are a documented failure (BrowserArena above). A ~60% verdict accuracy (the tester study) means roughly 4 wrong verdicts in 10.
3. **Where tests come from.** The proposal says the cases come from the plan. The current design writes UI tests **from the ACs, never from the plan's approach**, so that tests can't share the implementer's reading. A browser agent working from the plan would break that separation.
4. **Trust boundary.** The pages it reads are rendered by code an AI just wrote, over seeded data. That is untrusted input driving a tool-using model. Our rules also forbid model-driven MCP in any step, and the accept stage was decided to be deterministic with no model.

The current design (a model writes Playwright scripts once → proven failing on base → hash-locked → replayed in the sealed lab at zero model cost per run) keeps every one of these properties. It also yields replayable evidence: screenshot, trace and axe results per AC.

### 1c. Where an LLM-driven browser could add value

| Use | Value | Good enough locally? | Recommendation |
|---|---|---|---|
| **Better selectors for UI tests** | Real: brittle selectors are the main cause of flaky UI tests | Not needed. The core can capture ARIA snapshots deterministically (`locator.ariaSnapshot()`) of the base app's touched screens and of the design mock | **Adopt, with no model in the loop.** Add "screen outlines" (ARIA YAML) as a derived input to author-tests. Tests still come from ACs. The outline only tells the author the real roles and names. For *new* screens use the design mock's outline, and have the spec pin the accessible names of new controls |
| **Exploratory smoke walk** (touched screens: console errors, 500s, dead links, obvious breakage the ACs didn't name) | Moderate. One study found 29 usability issues that traditional tools missed (WebProber, https://arxiv.org/abs/2509.05197, 2025-09), but reported no false-positive rate | Weak: the snapshots exceed the 16K local pack after a few steps, and small models chain tools poorly | **Experiment flag, off by default, advisory only.** Findings go to review as candidates, never block. Most of the value (console and network errors on touched routes) comes from a **deterministic crawler in the accept replay**, which should come first |
| **Accept-stage evidence capture** | None extra. The locked scripts already produce screenshots, traces, axe results, HTTP and DB rows | n/a | **Keep accept deterministic** |
| **Repairing a broken selector** in a locked test | Useful as a suggestion | A hosted T2 is fine; local is marginal | **Only as evidence on the existing test-defect/unlock card.** Auto-healing a locked test is an unlock and would hide regressions |
| **A UI check a script can't express** (layout looks right, style-only changes) | Real, but it needs vision and judgement. VLM judges agree with humans only 48–68% (BrowserArena) | No | Keep these as **manual ACs** with screenshot evidence and human accept. An optional frontier-vision comment may go on the card as advisory |

### 1d. Practical fit

- **Sealed lab.** The browser and app live in the no-network namespace. A local model runs on the host (Ollama) or needs its own GPU container. Either the model reaches into the sealed namespace (a new channel out of the lab) or the core relays tool calls (`docker exec`/stdio). The relay is feasible, but it adds a model-driven tool loop to a stage we made deterministic. It also means building a browser-tool server in the core, because model-driven MCP is banned.
- **Hardware.** gpt-oss-20b needs ~16 GB VRAM at 8K context and ~24 GB at 32K. An 8 GB laptop GPU fits it only at a very low-quality quantisation, or offloads it at ~5.7 tok/s (https://runaihome.com/blog/gpt-oss-20b-local-ai-hardware-guide-2026/, 2026-06; https://willitrunai.com/can-run/gpt-oss-20b-on-rtx-4060-8gb, 2026). It shares WSL2 memory with Postgres, the .NET app, Next.js and Chromium.
- **Time per step.** Prefill for gpt-oss-20b is ~2,230 tok/s on an RTX 3060 12 GB but ~115 tok/s CPU-only on a mobile Ryzen (estimate from an analogue) (https://specpicks.com/reviews/gpt-oss-20b-rtx-3060-12gb-vs-ryzen-5-5600g-cpu-2026, 2026-09-26). A 10K-token snapshot therefore takes **~5 s on a desktop-class GPU, ~90 s CPU-only**, per step, before any output. A 10-step AC comes to about 1–15 minutes, against seconds for a scripted Playwright test. **Estimate (H); the laptop's real GPU is unknown.**

### 1e. Is it "free"?

No:
- **Tokens.** One dashboard snapshot (~12K) plus the tool definitions (~4K) already fills the 16K local pack. By our rule, a pack that doesn't fit goes to a frontier model, never a trimmed local call. So most real sessions would escalate to paid models, or break the rule.
- **Machine time.** Minutes per AC per run on a laptop, repeated for every verify, integrate and accept pass and every retry. The scripted test costs the model once, at authoring.
- **Failure cost.** At ~50–65% task success, many runs fail for the agent's own reasons. Each costs a retry, a human triage, or a wrongly parked run. That human time is the most expensive item.
- **Build cost.** A browser-tool server in the core, a relay into the sealed namespace, and new evidence types. That is weeks of POC time, with the demo on 2026-10-01.

**Verdict 1: reject as proposed.** Adopt the three narrow changes in 1c (screen outlines for test authors; deterministic console/network crawl in accept; advisory smoke walk and selector-fix suggestions behind flags). None of this is needed for the 2026-10-01 demo; the screen-outline capture is the only one worth building soon.

---

## 2. Prompt-first brownfield runs with a second clarify round

### Against the design
- **Intake.** Already accepts `prompt` (primary) and/or `ticket`. The stage catalogue records the owner's 2026-09-27 decision that the prompt is the main brownfield input. Intake stays local/Haiku.
- **Trust.** The context rules class "human answers typed on the TTY" as **trusted**, which may flow into any step, including writing steps. A typed prompt is different in practice: operators paste client emails, Slack threads and ticket text. ASPI (https://arxiv.org/html/2605.17324, 2026-05-17) shows that injection embedded in text the agent *asked for* succeeds far more often: o3 1.8% → 34.0%, Gemini-3-Flash 2.2% → 35.7%, Kimi K2.5 11.1% → 63.1%. Prompt guards and tool filters only partly help. **Change:** classify the raw prompt as *operator-attested but untrusted content*. Only locked-room steps read it raw (they already do), coding agents get the derived spec, and the ledger records the operator identity. The same rule should cover free-text clarify answers. Multiple-choice answers stay trusted.
- **Auto-proceed.** The spec gate's "source is an internal ticket" condition has no meaning for prompts. **Change:** a prompt counts as an internal source only for an allow-listed operator. The approval card always shows the prompt verbatim, and a prompt that the core finds contains pasted foreign text (email headers, quoted ticket text) never auto-proceeds.
- **Traceability without Jira.** The ledger's intent record should hold the exact prompt, its sha256, operator (OS user + git `user.email`), time, CLI version, an optional `--ref` (free text, marked unverified), all questions and answers, and the intent-span → REQ links that already exist. The PR body quotes the prompt and carries the run ID and manifest hash. Later edits go through `steer`, never by editing the record. An optional Jira sink can create a ticket after approval (look up before create), which is already a "later" item.
- **Why prompts need clarify more.** Prompts are shorter and less groomed than tickets, with no stack traces, links or ACs, so the sketch-disagreement method will flag more gaps. Grounding also has fewer hints (see §3). Interaction recovers most of the loss from underspecification: Claude Sonnet 4 reached 89% of fully-specified performance, and agents asked 2.6–6 questions (Ambig-SWE, https://arxiv.org/html/2502.13069, v3 2026-02-21, ICLR 2026).

### How many questions help vs annoy
| Evidence | Finding | Source |
|---|---|---|
| RegretBench (up to 5 turns) | Best policies ~1.1–1.2 turns at 75–79% success. A model at 4+ turns reached 74% with **negative overall reward**. More questions don't raise accuracy proportionally | https://arxiv.org/html/2607.21143v2 (2026-07-24) |
| EVPI stopping rule | Coverage +7–39% with 1.5–2.7× fewer questions when asking only while value exceeds cost | https://arxiv.org/html/2511.08798v2 (already in our intent-to-spec research) |
| Timing | Goal questions lose nearly all value by ~70% of the way through; constraint questions still help late | https://arxiv.org/html/2605.07937 (already cited) |
| Spec Kit practice | ≤5 questions, multiple choice with a recommended option; everything else is an assumption | https://github.com/github/spec-kit (already cited) |
| Under-asking | Sonnet 4.5 asked 0.29 turns where ~1.65 were needed | https://arxiv.org/abs/2607.00711 (already cited, UNVERIFIED) |
| Developer study | Developers preferred focused clarifying questions (68% favourable on precision). **No data on annoyance or on the number of questions** | https://arxiv.org/html/2507.21285v1 (2025-07) |

**Reading:** one well-chosen round is the norm. A second round pays only for gaps the first answers *create*, and those are usually constraint-level, which still help late. No study measured developer annoyance per question (**not found**).

**Verdict 2: adopt with changes.**
- Second round only when the answers create **new** disagreements with impact 3 (data, permissions, money) or impact × uncertainty ≥ 6. Cap it at **3 questions** (8 in total). Re-run the sketches only for the affected spans.
- Low-risk runs: no second round; leftover gaps become assumptions on the card. Keep the old "confirm on the card" behaviour for high-risk assumptions that don't clear the bar.
- The prompt operator is usually at the terminal, so ask synchronously when possible. The 24h default timeout still applies otherwise.
- Clarify stays frontier, never local (Qwen3 Coder's 100% miss rate on underspecification, Ambig-SWE).
- Apply the trust, auto-proceed and traceability changes above.

---

## 3. Ground stage on Opus 5.5 instead of Sonnet 5

### Evidence on localization
| Evidence | Finding | Source |
|---|---|---|
| LocAgent (ACL 2025) | Claude-3.5 vs fine-tuned Qwen-7B on Loc-Bench: file Acc@10 87.1% vs 80.4%, **function Acc@15 62.1% vs 52.4%**. On SWE-bench Lite, file-level was close (94.2 / 92.7 / 88.3). The gap grows at finer granularity. Cost $0.66 vs $0.05 per task | https://arxiv.org/abs/2503.09089 (tables via ar5iv) |
| MULocBench (1,100 issues) | Claude 3.5 35.2% vs GPT-4o-mini 16.1% file Acc@5 (LocAgent). Larger model tier wins across most methods; absolute numbers are low on realistic issues | https://arxiv.org/html/2509.25242 (2025-09) |
| ContextBench (1,136 tasks, 8 languages) | "Stronger models don't consistently retrieve better". Sonnet 4.5 block-F1 0.420 vs GPT-5 0.375. **Scaffold choice swings F1 0.19–0.375** with the same model. All models over-retrieve (recall over precision) | https://arxiv.org/html/2602.05892v1 (2026-02); leaderboard https://contextbench.github.io/ (updated 2026-09-14) |
| Multi-file change localization | Codex 5.5 High recovered the most all-gold instances (9.2); a Haiku-class domain-agent system 6.4; plain Sonnet favoured precision over recall. "Exploration structure is a second-order factor"; parallel domain-scoped exploration beats sequential browsing | https://arxiv.org/html/2606.11976v1 (2026-06) |
| SWE-Explore (in our earlier research) | File-level localization "already strong"; line-level recall is the gap | https://arxiv.org/abs/2606.07297 (UNVERIFIED) |
| Opus 5.5 vs Sonnet 5 | Opus 5.5 (released 2026-09-22) leads Sonnet 5 on all 12 shared benchmarks (e.g. SWE-bench Verified; Sonnet 5 85.2%). Self-reported; **no localization-specific head-to-head found** | https://llm-stats.com/models/compare/claude-opus-5-5-vs-claude-sonnet-5 (read 2026-09-27) |

**Reading:** a stronger model tends to raise recall, most at the function/symbol level, which is what ground produces. Search structure matters as much: seeds, graph queries and parallel scoped exploration. The size of the Opus 5.5 over Sonnet 5 gain on our repos is **unknown**.

### Cost (list prices, https://platform.claude.com/docs/en/about-claude/pricing, read 2026-09-27)
| per MTok | Input | 5-min cache write | Cache read | Output | Batch in/out |
|---|---|---|---|---|---|
| Opus 5.5 | $4 | $5 | **$0.20** (0.05×) | $20 | $2 / $10 |
| Sonnet 5 | $2 | $2.50 | **$0.20** (0.1×) | $10 | $1 / $5 |

Sonnet 5's $2/$10 is now the standard price; the planned rise to $3/$15 was cancelled. Opus 5.5 cannot turn thinking off (effort is the only control; default medium). Sonnet 5 can.

**Per-run estimate for ground** (H: 8 turns, prefix ~10K growing to ~40K; ~40K tokens written to cache, ~150K read from cache, ~13K output including thinking):
| | Cache writes | Cache reads | Output | Total |
|---|---|---|---|---|
| Sonnet 5 | $0.10 | $0.03 | $0.13 | **≈ $0.26** |
| Opus 5.5 | $0.20 | $0.03 | $0.26 | **≈ $0.49** |
| No caching (worst case) | Sonnet ≈ $0.51 | | Opus ≈ $1.03 | |

**Delta ≈ $0.23 cached, up to ≈ $0.50 uncached per run.** Because cache reads cost the same on both models, the multi-turn loop penalty comes almost entirely from output and thinking tokens. Setting the effort level is the main lever.

### Fit in a $3 bugfix cap
Rough low-risk bugfix run under the current tiers (H; GPT costs taken from the spec-stage ranges, not re-priced):
| Step | Model | Estimate |
|---|---|---|
| intake | local | $0 |
| ground | Sonnet 5 / Opus 5.5 | $0.26 / $0.49 |
| clarifier (sketches skipped on low-risk bugfix) | Opus 5.5 medium | ~$0.15 |
| specify (1 draft) | Sonnet 5 | ~$0.10 |
| critic | GPT | $0.30–0.60 |
| plan (always frontier, effort high) | Opus 5.5 | $0.30–0.60 |
| author-tests | Sonnet 5 agent | $0.30–0.80 |
| implement (S) | Sonnet 5 agent | $0.50–1.50 |
| review | GPT, effort high | $0.30–0.60 |
| **Total** | | **≈ $2.2–4.8 (Sonnet ground) / $2.4–5.1 (Opus ground)** |

The spec-stage model's "$1–3 whole bugfix run" already looks optimistic against the current tier choices. Opus ground adds 7–17% of the cap. That is affordable for features (caps of $5–20) but can tip bugfixes over.

**Contradiction to note:** the stage catalogue's ground row says Opus 5.5 (owner, 2026-09-27), while its own gap-decisions list still says "ground: L, T2". One of them needs correcting.

**Verdict 3: adopt with changes.**
- Opus 5.5 at effort medium for ground on **feature and medium/high-risk runs, and for prompt-first runs** (less structure to lean on).
- Low-risk bugfixes keep **Sonnet 5**, or use Opus 5.5 at effort low with ≤6 turns, until the eval shows a recall gain.
- **Measure on the eval set.** The 5–10 tasks mined from repo history have known changed files, so score both models on file- and symbol-level recall against the historic fix, plus cost.
- Improve recall by structure as well:
  - seed ground with deterministic hits (identifiers from the prompt, stack traces, the test map, `graph_query` neighbours);
  - have the core diff the plan's task file scopes against ground's anchors, and show "files planned but not grounded" on the card.
