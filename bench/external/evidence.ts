// Evidence pack: what backs each headline figure of an estimate, so a reader can see where a number comes
// from and how far it sits from measured and external data. Meant to be attached to the shared estimate
// (an "Evidence" sheet in both workbooks and a section on the approval card); see estimates-design.md, "Evidence".
//
// Rules that keep it unambiguous:
//   - every row says what the estimate rests on (a ledger-calibrated model, or an assumption) and where the
//     reference comes from (the factory's own ledger, pinned public data, or nowhere)
//   - every row states a verdict, and "no reference" and "cold-start" are verdicts, never blanks
//   - every external row names its source and what that source can't show
// The EstimateInput below is provisional: the real Estimate artifact isn't built yet.
import { band, confidence, type Confidence } from "../calibration/stats.js";
import type { BenchRecord } from "../calibration/records.js";
import { load, type Source } from "./priors.js";

export interface EstimateInput {
  deliveryModel: "hitl" | "agentic";
  /** planning phases (intake to plan) in API-credit dollars, the range shown on the estimate */
  planningCostUsd: { min: number; max: number };
  /** planning phases in elapsed minutes */
  planningMinutes: { min: number; max: number };
  /** every task with the human-equivalent minutes of its anchor sizing; factory and joint tasks also carry the estimated factory minutes */
  tasks: { id: string; humanEquivMinutes: number; executor: "factory" | "joint" | "human"; factoryMinutes?: number }[];
  /** the PRs the tasks group into, with their expected size in changed lines */
  prs: { id: string; lines: number }[];
  assumptions: {
    /** share of factory tasks expected to exhaust the retry ladder and park */
    parkedRunRate: number;
    /** elapsed hours from PR opened to merged, per PR: agent time plus, in HITL, the review queue */
    prToMergeHours: number;
  };
}

/** What the estimated number rests on. */
export type Rests = "ledger-calibrated" | "assumed";
/** Where the reference it is compared with comes from. */
export type ReferenceFrom = "ledger" | "external" | "none";
export type Verdict = "consistent" | "outside reference" | "no reference" | "cold-start";

export interface EvidenceRow {
  id: string;
  claim: string;
  estimate: string;
  rests: Rests;
  referenceFrom: ReferenceFrom;
  reference: string;
  verdict: Verdict;
  /** records or runs behind the reference */
  n?: number;
  confidence?: Confidence;
  source?: string;
  caveat: string;
}

/** A value is "consistent" with a reference when it is within this factor either way. An assumption; tune it. */
export const TOLERANCE_X = 2;
/** Stages that make up planning cost, matching the estimate's "planning" phase. */
export const PLANNING_STAGES = ["intake", "discover", "ground", "clarify", "clarify-2", "drafts", "merge", "specify", "plan"];

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;
const within = (v: number, ref: number) => v >= ref / TOLERANCE_X && v <= ref * TOLERANCE_X;

// METR's human-time buckets, same cut-offs as bench/external/derive/metr.py.
const METR_CUTS = [5, 15, 60, 240, 960];
const metrBucket = (minutes: number) => 1 + METR_CUTS.filter((c) => minutes > c).length;
const AIDEV_CUTS = [20, 100, 400, 1000];
const aidevBand = (lines: number) => 1 + AIDEV_CUTS.filter((c) => lines > c).length;

interface MetrSnap {
  source: Source; caveats: string[];
  suites: Record<string, { byHumanDuration: { bucket: string; success: number; runs: number; agent_wall_min_median: number | null; agent_wall_min_p90: number | null }[] }>;
}
interface AidevBand {
  band: string; prs: number;
  mergeHoursMedianReviewed: number | null; mergeHoursP90Reviewed: number | null;
  mergeHoursMedianUnreviewed: number | null; mergeHoursP90Unreviewed: number | null;
}
interface AidevSnap { source: Source; overallBySize: AidevBand[] }

export interface EvidenceOptions { metr?: MetrSnap | null; aidev?: AidevSnap | null }

const minutes = (n: number) => (n >= 90 ? `${(n / 60).toFixed(1)} h` : `${Math.round(n)} min`);

export function buildEvidence(est: EstimateInput, ledger: BenchRecord[], opts: EvidenceOptions = {}): EvidenceRow[] {
  const metr = opts.metr === undefined ? load<MetrSnap>("metr") ?? null : opts.metr;
  const aidev = opts.aidev === undefined ? load<AidevSnap>("aidev") ?? null : opts.aidev;
  const rows: EvidenceRow[] = [];

  // 1. Planning cost and time against the factory's own runs (ledger).
  const perRun = new Map<string, { cost: number; min: number }>();
  for (const r of ledger) {
    if (r.outcome !== "completed" || !PLANNING_STAGES.includes(r.stage)) continue;
    const cur = perRun.get(r.runId) ?? { cost: 0, min: 0 };
    perRun.set(r.runId, { cost: cur.cost + r.costUsd, min: cur.min + r.wallMin });
  }
  const planningRuns = [...perRun.values()];
  const ledgerRow = (id: string, claim: string, est: { min: number; max: number }, fmt: (n: number) => string, pick: (r: { cost: number; min: number }) => number): EvidenceRow => {
    const estimate = `${fmt(est.min)} to ${fmt(est.max)}`;
    if (!planningRuns.length) return { id, claim, estimate, rests: "assumed", referenceFrom: "none", reference: "no finished planning run in the ledger", verdict: "no reference", caveat: "Nothing measured yet; treat the figure as an assumption." };
    const b = band(planningRuns.map(pick));
    const c = confidence(b.n);
    return {
      id, claim, estimate, rests: "ledger-calibrated", referenceFrom: "ledger",
      reference: `${b.n} run(s): p10 ${fmt(b.p10)} · p50 ${fmt(b.p50)} · p90 ${fmt(b.p90)}`,
      verdict: c === "cold-start" ? "cold-start" : est.max >= b.p10 && est.min <= b.p90 ? "consistent" : "outside reference", n: b.n, confidence: c,
      caveat: c === "cold-start"
        ? "Fewer than 3 runs, so the band is a single observation and no verdict is drawn."
        : "The estimate is calibrated from the same ledger, so agreement is a consistency check, not independent evidence. Runs differ in size; the band is per run, not per requirement.",
    };
  };
  rows.push(ledgerRow("cost.planning", "Planning cost (intake to plan), API credits", est.planningCostUsd, usd, (r) => r.cost));
  rows.push(ledgerRow("time.planning", "Planning time (intake to plan), elapsed", est.planningMinutes, minutes, (r) => r.min));

  // 2. Parked-run rate against agent reliability by task duration (external) and first-time pass (measured).
  const factoryTasks = est.tasks.filter((t) => t.executor !== "human");
  const suite = metr?.suites["1-1"]?.byHumanDuration;
  if (suite && factoryTasks.length) {
    let expectedSuccess = 0;
    for (const t of factoryTasks) expectedSuccess += (suite.find((s) => s.bucket.startsWith(`${metrBucket(t.humanEquivMinutes)}:`))?.success ?? 0) / factoryTasks.length;
    const implied = 1 - expectedSuccess;
    const impl = ledger.filter((r) => r.stage === "implement" && r.outcome !== "pending");
    const own = impl.length ? impl.filter((r) => r.outcome === "completed" && r.retries === 0).length / impl.length : undefined;
    rows.push({
      id: "reliability.parked", claim: "Share of factory tasks that park (exhaust retries)", estimate: pct(est.assumptions.parkedRunRate), rests: "assumed", referenceFrom: "external",
      reference: `METR success for tasks of this human-time mix implies about ${pct(implied)} would not pass first time${own === undefined ? "; no implement steps in the ledger yet" : `; the factory's own first-time pass is ${pct(own)} over ${impl.length} step(s)`}`,
      verdict: est.assumptions.parkedRunRate * TOLERANCE_X >= implied ? "consistent" : "outside reference",
      n: suite.reduce((n, s) => n + s.runs, 0), source: metr!.source.url,
      caveat: "Direction check only. METR measures a first attempt on research, ML and security tasks, not retries on feature work, and 'not passing' is not the same as 'parked'.",
    });
  } else {
    rows.push({ id: "reliability.parked", claim: "Share of factory tasks that park", estimate: pct(est.assumptions.parkedRunRate), rests: "assumed", referenceFrom: "none", reference: "no external snapshot or no factory tasks", verdict: "no reference", caveat: "Assumption only." });
  }

  // 3. Factory time per task against how long agents took in public runs (external, an upper bound).
  const timed = factoryTasks.filter((t) => t.factoryMinutes !== undefined);
  if (metr && suite && timed.length) {
    const ref = (t: (typeof timed)[number]) => suite.find((x) => x.bucket.startsWith(`${metrBucket(t.humanEquivMinutes)}:`));
    const over = timed.filter((t) => { const p90 = ref(t)?.agent_wall_min_p90; return typeof p90 === "number" && t.factoryMinutes! > p90; });
    const humanTotal = timed.reduce((n, t) => n + t.humanEquivMinutes, 0);
    const factoryTotal = timed.reduce((n, t) => n + t.factoryMinutes!, 0);
    const p50s = timed.map((t) => ref(t)?.agent_wall_min_median).filter((v): v is number => typeof v === "number");
    rows.push({
      id: "time.task", claim: "Factory time per task (agent working time, before review)",
      estimate: `${minutes(factoryTotal)} across ${timed.length} task(s), against ${minutes(humanTotal)} of human-equivalent work`,
      rests: "assumed", referenceFrom: "external",
      reference: `public agent runs on tasks of the same human-time sizes took a median of ${p50s.length ? minutes(band(p50s).p50) : "n/a"} each (upper bound); ${timed.length - over.length} of ${timed.length} tasks are at or below the p90 wall time for their size${over.length ? `; above it: ${over.map((t) => t.id).join(", ")}` : ""}`,
      verdict: over.length ? "outside reference" : "consistent", n: suite.reduce((n, x) => n + x.runs, 0), source: metr.source.url,
      caveat: "An upper bound only. METR's wall time includes queueing, sandbox waits and retries (it is minutes to hours even for 5-minute tasks), so an estimate far below it is expected and is not evidence of speed. It says the estimate is not slower than public agents took.",
    });
  } else {
    rows.push({ id: "time.task", claim: "Factory time per task", estimate: timed.length ? `${timed.length} task(s)` : "not stated", rests: "assumed", referenceFrom: "none", reference: "no external snapshot, or no factory minutes on the tasks", verdict: "no reference", caveat: "Assumption only." });
  }

  // 4. PR opened to merged, per PR, against agent PRs on GitHub (external): reviewed for HITL, unreviewed for agentic.
  if (est.prs.length) {
    const hitl = est.deliveryModel === "hitl";
    const bands = aidev?.overallBySize ?? [];
    const found = est.prs.map((p) => bands.find((b) => b.band.startsWith(`${aidevBand(p.lines)}:`)));
    const p50s = found.map((b) => (hitl ? b?.mergeHoursMedianReviewed : b?.mergeHoursMedianUnreviewed)).filter((v): v is number => typeof v === "number");
    const p90s = found.map((b) => (hitl ? b?.mergeHoursP90Reviewed : b?.mergeHoursP90Unreviewed)).filter((v): v is number => typeof v === "number");
    const claim = `Elapsed hours from PR opened to merged, per PR (${hitl ? "lead reviews every PR" : "merged automatically"})`;
    if (aidev && p50s.length === est.prs.length && p90s.length === est.prs.length) {
      const lo = band(p50s).p50, hi = band(p90s).p50;
      const v = est.assumptions.prToMergeHours;
      rows.push({
        id: "time.pr", claim, estimate: `${v} h`, rests: "assumed", referenceFrom: "external",
        reference: `${hitl ? "human-reviewed" : "unreviewed"} agent PRs of these sizes: median ${lo.toFixed(1)} h, p90 ${hi.toFixed(1)} h (${est.prs.length} PRs in size bands ${[...new Set(est.prs.map((p) => aidevBand(p.lines)))].sort().join(",")})`,
        verdict: v >= lo / TOLERANCE_X && v <= hi ? "consistent" : "outside reference",
        n: aidev.overallBySize.reduce((n, b) => n + b.prs, 0), source: aidev.source.url,
        caveat: hitl
          ? "Public repositories, wall-clock including nights and weekends, and not the factory's rule of a lead reviewing every PR. Consistent means between half the median and the p90."
          : "Unreviewed PRs are mostly self-merged in personal repos, so the median is a floor for how fast a merge can happen. Consistent means between half the median and the p90.",
      });
    } else {
      rows.push({ id: "time.pr", claim, estimate: `${est.assumptions.prToMergeHours} h`, rests: "assumed", referenceFrom: "none", reference: "no external snapshot", verdict: "no reference", caveat: "Assumption only." });
    }
  }

  return rows;
}

export function formatEvidence(rows: EvidenceRow[]): string {
  const out = ["# Evidence for this estimate", "", "Each figure below says what it rests on. Verdicts compare the estimate with the reference within a factor of " + TOLERANCE_X + " (an assumption).", ""];
  for (const r of rows) {
    out.push(
      `## ${r.claim}`,
      `- Estimate: **${r.estimate}** (rests on: ${r.rests})`,
      `- Reference (${r.referenceFrom}): ${r.reference}`,
      `- Verdict: **${r.verdict}**${r.confidence && r.confidence !== r.verdict ? ` · ${r.confidence}` : ""}${r.n ? ` · n=${r.n}` : ""}`,
    );
    if (r.source) out.push(`- Source: ${r.source}`);
    out.push(`- Limits: ${r.caveat}`, "");
  }
  return out.join("\n");
}
