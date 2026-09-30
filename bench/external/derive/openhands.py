"""SWE-rebench OpenHands trajectories -> tool-call rounds per task, resolved vs not.
Source: https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories (pinned revision in sources.json).
Read remotely with DuckDB (only the trajectory column). Run: uv run --with duckdb python bench/external/derive/openhands.py
"""
import json
from pathlib import Path
import duckdb

ROOT = Path(__file__).resolve().parents[1]
SRC = json.loads((ROOT / "sources.json").read_text())["openhands"]
U = f"https://huggingface.co/datasets/nebius/SWE-rebench-openhands-trajectories/resolve/{SRC['revision']}/trajectories.parquet"

con = duckdb.connect()
con.sql("INSTALL httpfs; LOAD httpfs;")
con.sql(f"""
CREATE TEMP TABLE t AS
SELECT trajectory_id, resolved, exit_status,
  len(list_filter(trajectory, x -> x.role = 'assistant')) AS assistant_turns,
  len(list_filter(trajectory, x -> x.role = 'assistant' AND x.tool_calls IS NOT NULL AND len(x.tool_calls) > 0)) AS tool_rounds,
  length(model_patch) AS patch_chars
FROM '{U}'""")

def q(sql, cols):
    return [dict(zip(cols, r)) for r in con.sql(sql).fetchall()]

stat = lambda c: f"""round(quantile_cont({c}, 0.1), 0) AS {c}_p10, round(median({c}), 0) AS {c}_p50, round(quantile_cont({c}, 0.9), 0) AS {c}_p90"""
by_outcome = q(f"""SELECT resolved, count(*) AS n, {stat('tool_rounds')} FROM t GROUP BY 1 ORDER BY 1""",
               ["resolved", "n", "roundsP10", "roundsP50", "roundsP90"])
overall = q(f"SELECT count(*) AS n, round(avg(resolved), 3) AS resolved_rate, {stat('tool_rounds')} FROM t",
            ["n", "resolvedRate", "roundsP10", "roundsP50", "roundsP90"])
exit_status = q("SELECT exit_status, count(*) AS n, round(avg(resolved), 3) AS r FROM t GROUP BY 1 ORDER BY 2 DESC LIMIT 8", ["exitStatus", "n", "resolvedRate"])
by_patch = q("""SELECT CASE WHEN patch_chars IS NULL OR patch_chars = 0 THEN '0: no patch' WHEN patch_chars <= 500 THEN '1: <=500 chars'
    WHEN patch_chars <= 2000 THEN '2: 501-2000' WHEN patch_chars <= 8000 THEN '3: 2001-8000' ELSE '4: >8000' END AS band,
    count(*) AS n, round(avg(resolved), 3) AS resolved_rate, round(median(tool_rounds), 0) AS rounds_p50
  FROM t GROUP BY 1 ORDER BY 1""", ["patchSize", "n", "resolvedRate", "roundsP50"])
out = {
    "source": SRC, "derivedBy": "bench/external/derive/openhands.py",
    "unit": "tool round = one assistant message that calls a tool",
    "overall": overall[0], "byOutcome": by_outcome, "byExitStatus": exit_status, "byPatchSize": by_patch,
    "caveats": [
        "One model (Qwen3-Coder-480B) on one scaffold (OpenHands 0.54), on Python repos from SWE-rebench. Rounds and resolve rate will differ for Claude on the factory's agent.",
        "Tasks are single GitHub issues, mostly small fixes; they are not multi-file feature work.",
        "The dataset has no tokens, dollars or wall time, so rounds are the only effort measure taken from it.",
        "byPatchSize uses the length of the model's patch text as a rough size proxy.",
    ],
}
(ROOT / "snapshots" / "openhands.json").write_text(json.dumps(out, indent=1))
print("wrote snapshots/openhands.json")
