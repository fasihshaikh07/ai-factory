"""AIDev -> merge rate, time to merge and time to first human review, by PR size and agent.
Source: https://huggingface.co/datasets/hao-li/AIDev (pinned revision in sources.json). Read remotely with DuckDB.
Run: uv run --with duckdb python bench/external/derive/aidev.py
"""
import json
from pathlib import Path
import duckdb

ROOT = Path(__file__).resolve().parents[1]
SRC = json.loads((ROOT / "sources.json").read_text())["aidev"]
B = f"https://huggingface.co/datasets/hao-li/AIDev/resolve/{SRC['revision']}/"

con = duckdb.connect()
con.sql("INSTALL httpfs; LOAD httpfs;")
con.sql(f"""
CREATE TEMP TABLE size AS
SELECT pr_id, sum(lines) AS lines, sum(files) AS files FROM (
  SELECT pr_id, sha, max(commit_stats_total) AS lines, count(DISTINCT filename) AS files
  FROM '{B}pr_commit_details.parquet' GROUP BY pr_id, sha) GROUP BY pr_id""")
con.sql(f"""
CREATE TEMP TABLE review AS
SELECT pr_id, min(try_cast(submitted_at AS TIMESTAMPTZ)) AS first_review
FROM '{B}pr_reviews.parquet' WHERE user_type = 'User' GROUP BY pr_id""")
con.sql(f"""
CREATE TEMP TABLE pr AS
SELECT p.id, p.agent, p.state,
  try_cast(p.created_at AS TIMESTAMPTZ) AS created, try_cast(p.merged_at AS TIMESTAMPTZ) AS merged,
  try_cast(p.closed_at AS TIMESTAMPTZ) AS closed, s.lines, s.files, r.first_review,
  CASE WHEN s.lines <= 20 THEN '1: <=20 lines' WHEN s.lines <= 100 THEN '2: 21-100'
       WHEN s.lines <= 400 THEN '3: 101-400' WHEN s.lines <= 1000 THEN '4: 401-1000' ELSE '5: >1000' END AS band
FROM '{B}pull_request.parquet' p JOIN size s ON s.pr_id = p.id LEFT JOIN review r ON r.pr_id = p.id""")

def table(group):
    q = f"""
    SELECT {group} AS grp, band, count(*) AS prs,
      round(avg((merged IS NOT NULL)::int), 3) AS merge_rate,
      round(median(epoch(merged - created) / 3600.0) FILTER (WHERE merged IS NOT NULL), 2) AS merge_h_median,
      round(quantile_cont(epoch(merged - created) / 3600.0, 0.9) FILTER (WHERE merged IS NOT NULL), 2) AS merge_h_p90,
      round(median(epoch(merged - created) / 3600.0) FILTER (WHERE merged IS NOT NULL AND first_review IS NOT NULL), 2) AS merge_h_median_reviewed,
      round(quantile_cont(epoch(merged - created) / 3600.0, 0.9) FILTER (WHERE merged IS NOT NULL AND first_review IS NOT NULL), 2) AS merge_h_p90_reviewed,
      round(median(epoch(merged - created) / 3600.0) FILTER (WHERE merged IS NOT NULL AND first_review IS NULL), 2) AS merge_h_median_unreviewed,
      round(quantile_cont(epoch(merged - created) / 3600.0, 0.9) FILTER (WHERE merged IS NOT NULL AND first_review IS NULL), 2) AS merge_h_p90_unreviewed,
      round(avg((first_review IS NOT NULL)::int), 3) AS human_review_rate,
      round(median(epoch(first_review - created) / 3600.0) FILTER (WHERE first_review IS NOT NULL AND first_review >= created), 2) AS first_review_h_median,
      round(median(files), 1) AS files_median
    FROM pr GROUP BY 1, 2 ORDER BY 1, 2"""
    cols = ["group", "band", "prs", "mergeRate", "mergeHoursMedian", "mergeHoursP90", "mergeHoursMedianReviewed", "mergeHoursP90Reviewed", "mergeHoursMedianUnreviewed", "mergeHoursP90Unreviewed", "humanReviewRate", "firstReviewHoursMedian", "filesMedian"]
    return [dict(zip(cols, r)) for r in con.sql(q).fetchall()]

tot = con.sql("SELECT count(*), sum((merged IS NOT NULL)::int) FROM pr").fetchone()
out = {
    "source": SRC, "derivedBy": "bench/external/derive/aidev.py",
    "prsUsed": tot[0], "prsMerged": tot[1],
    "overallBySize": table("'all agents'"),
    "byAgentAndSize": table("agent"),
    "caveats": [
        "Lines = sum over commits of GitHub's per-commit total (additions + deletions); it can double-count work that is reverted or rewritten inside one PR.",
        "Time to merge is wall-clock hours from PR creation to merge, including nights, weekends and waiting on the author. It is not reviewer effort.",
        "Most PRs are merged with no human review (humanReviewRate is about 20-40%), often by their own author in a personal repo, so the overall median merge time is minutes. mergeHoursMedianReviewed restricts to PRs that a human reviewed, and is the closer stand-in for the factory's HITL lead review.",
        "mergeHoursMedianUnreviewed is the stand-in for the solely agentic model (merge with no human review), but those PRs are mostly self-merged in personal repos, so it is a floor for how fast a merge can happen and not a typical client project.",
        "Human review means a review by a user of type 'User' (not a bot). PRs merged with no review are counted in mergeRate but not in firstReviewHoursMedian.",
        "PRs come from public GitHub repositories with AI-agent authors (Codex, Copilot, Devin, Cursor, Claude Code, Jules), which is not the factory's HITL setup.",
        "Only PRs that have commit details are used (prsUsed).",
    ],
}
(ROOT / "snapshots" / "aidev.json").write_text(json.dumps(out, indent=1))
print("wrote snapshots/aidev.json", tot)
