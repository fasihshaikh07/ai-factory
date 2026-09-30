# bench/external/: public agentic-development data, pinned

Reference numbers from public datasets, so the factory's own runs have something outside the ledger to be read against.
Everything is pinned to a commit or dataset revision in `sources.json`, and reduced to small aggregates in `snapshots/`.
The factory's runtime never calls the network; these files are read offline (`npm run bench -- external`).

| Snapshot | Source | What it gives | What it cannot tell you |
|---|---|---|---|
| `metr.json` | METR `eval-analysis-public` (HCAST, RE-Bench, SWAA runs) | Agent success and tokens by how long a human expert takes (5 min to 16+ h) | Dollars, and real agent working time (wall time includes queueing) |
| `aidev.json` | AIDev, `hao-li/AIDev` (CC-BY-4.0), ~71k agent PRs on GitHub | Merge rate, human-review rate, time to first review and to merge, by PR size and agent | Reviewer effort, and lead review of every PR (most of these PRs are merged unreviewed) |
| `openhands.json` | `nebius/SWE-rebench-openhands-trajectories` (CC-BY-4.0), 67k runs | Tool-call rounds per task, resolved vs not | Tokens, dollars, time; one model (Qwen3-Coder) and Python issue fixes only |

## Rebuild
```
bench/external/fetch.sh                                            # METR raw files -> raw/ (git-ignored)
uv run --with duckdb python bench/external/derive/metr.py
uv run --with duckdb python bench/external/derive/aidev.py         # reads the dataset remotely
uv run --with duckdb python bench/external/derive/openhands.py     # scans ~2 GB remotely; takes minutes
```
Each snapshot carries its `source` (URL, revision, licence, retrieval date) and its `caveats`.

## Looked at and not used
- **HAL (Holistic Agent Leaderboard):** the only source found with dollar cost per task, but its traces on `agent-evals/hal_traces` are encrypted to avoid contamination, and the published leaderboard numbers are on benchmarks (SWE-bench Verified Mini, USACO, etc.) far from feature work.
- **SWE-bench Pro / Verified, SWE-agent-trajectories, SWE-smith:** resolve rates and trajectories, but no time or cost columns beyond what OpenHands already gives.
- **agent-estimate, agent-estimation, ACEM:** estimation *methods* with unvalidated constants (see `estimates-design.md`), not datasets.

## Gap
There is **no public dataset of dollars per task for feature-sized work** that we could use. Cost has to come from the factory's own ledger, priced with `src/runners/pricing.ts`.
