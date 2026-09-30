"""METR time-horizon runs -> reliability, agent wall time and tokens by human task duration.
Source: https://github.com/METR/eval-analysis-public (raw runs.jsonl, pinned commit in sources.json).
Run: uv run --with duckdb python bench/external/derive/metr.py
"""
import json, sys
from pathlib import Path
import duckdb

ROOT = Path(__file__).resolve().parents[1]
SRC = json.loads((ROOT / "sources.json").read_text())["metr"]
BUCKET = """CASE WHEN human_minutes <= 5 THEN '1: <=5 min'
  WHEN human_minutes <= 15 THEN '2: 5-15 min'
  WHEN human_minutes <= 60 THEN '3: 15-60 min'
  WHEN human_minutes <= 240 THEN '4: 1-4 h'
  WHEN human_minutes <= 960 THEN '5: 4-16 h'
  ELSE '6: >16 h' END"""

con = duckdb.connect()
out = {"source": SRC, "derivedBy": "bench/external/derive/metr.py", "suites": {}}
for suite in ["1-1", "1-0"]:
    f = ROOT / "raw" / f"metr-th-{suite}-runs.jsonl"
    if not f.exists():
        sys.exit(f"missing {f}; run bench/external/fetch.sh first")
    base = f"read_json_auto('{f}')"
    rows = con.sql(f"""
      SELECT {BUCKET} AS bucket,
        count(DISTINCT task_id) AS tasks, count(*) AS runs,
        round(avg(score_binarized), 3) AS success,
        round(median(human_minutes), 1) AS human_min_median,
        round(median((completed_at - started_at) / 60000.0) FILTER (WHERE completed_at > started_at), 1) AS agent_wall_min_median,
        round(quantile_cont((completed_at - started_at) / 60000.0, 0.9) FILTER (WHERE completed_at > started_at), 1) AS agent_wall_min_p90,
        round(median(tokens_count) FILTER (WHERE tokens_count > 0), 0) AS tokens_median,
        round(quantile_cont(tokens_count, 0.9) FILTER (WHERE tokens_count > 0), 0) AS tokens_p90,
        sum((tokens_count > 0)::int) AS runs_with_tokens,
        sum((completed_at > started_at)::int) AS runs_with_time
      FROM {base} GROUP BY 1 ORDER BY 1""").fetchall()
    cols = ["bucket", "tasks", "runs", "success", "human_min_median", "agent_wall_min_median", "agent_wall_min_p90", "tokens_median", "tokens_p90", "runs_with_tokens", "runs_with_time"]
    by_alias = con.sql(f"""
      SELECT alias, {BUCKET} AS bucket, count(*) AS runs, round(avg(score_binarized), 3) AS success
      FROM {base} WHERE alias IN (SELECT alias FROM {base} GROUP BY 1 HAVING count(*) >= 200)
      GROUP BY 1, 2 ORDER BY 1, 2""").fetchall()
    tasks = con.sql(f"SELECT task_source, human_source, count(DISTINCT task_id), round(median(human_minutes),1) FROM {base} GROUP BY 1,2 ORDER BY 1,2").fetchall()
    out["suites"][suite] = {
        "byHumanDuration": [dict(zip(cols, r)) for r in rows],
        "byModelAndDuration": [dict(zip(["model", "bucket", "runs", "success"], r)) for r in by_alias],
        "taskSources": [dict(zip(["taskSource", "humanTimeSource", "tasks", "humanMinMedian"], r)) for r in tasks],
    }
out["caveats"] = [
    "human_minutes is a geometric-mean expert baseline for 'baseline' tasks and a judgment for 'estimate' tasks (see taskSources).",
    "Tasks are HCAST, RE-Bench and SWAA: research/ML/security/general software tasks, not client feature work.",
    "Agent wall time and tokens are only present on a subset of runs (runs_with_time, runs_with_tokens).",
    "Agent wall time is completed_at minus started_at in METR's run warehouse. It is far above the human time for short tasks (median 60 min on 5-15 min tasks), so it likely includes queueing, sandbox waits and retries. Treat it as an upper bound, not as agent working time.",
    "generation_cost is omitted: it is zero or implausibly small for most runs.",
]
(ROOT / "snapshots" / "metr.json").write_text(json.dumps(out, indent=1))
print("wrote snapshots/metr.json")
