// Policy and the stricter-only merge (gate-engine §2.9, contracts §3).
export interface Policy {
  allowedAgents: string[];
  allowedModels: string[];
  localOnly: boolean;
  protectedPaths: string[];
  escapeHatchAllowlist: string[];
  registryAllowlist: string[];
  maxDiffLines: number;
  retryBudget: number;
  waiverCap: number;
  minDiffCoverage: number;       // 0..1
  reviewConfidence: number;      // findings at/above this can block
  riskAutoProceed: "low" | "medium" | "none";
}

export const DEFAULT_POLICY: Policy = {
  allowedAgents: ["api", "claude-agent", "codex", "jcode"],
  allowedModels: ["*"],
  localOnly: false,
  protectedPaths: [],
  escapeHatchAllowlist: [],
  registryAllowlist: ["https://api.nuget.org/", "https://registry.npmjs.org/"],
  maxDiffLines: 1500,
  retryBudget: 6,
  waiverCap: 3,
  minDiffCoverage: 0,
  reviewConfidence: 0.7,
  riskAutoProceed: "low",
};

const intersect = (a: string[], b: string[]) => {
  if (a.includes("*")) return [...b];
  if (b.includes("*")) return [...a];
  return a.filter((x) => b.includes(x));
};
const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
const riskOrder = { none: 0, low: 1, medium: 2 } as const;

/**
 * Merge org → client → project → run. Each later layer can only tighten:
 * allowlists intersect, denylists/protected paths union, budgets take the minimum,
 * thresholds take the maximum, localOnly ORs.
 */
export function mergePolicy(base: Policy, ...layers: Partial<Policy>[]): Policy {
  let p = { ...base };
  for (const l of layers) {
    p = {
      allowedAgents: l.allowedAgents ? intersect(p.allowedAgents, l.allowedAgents) : p.allowedAgents,
      allowedModels: l.allowedModels ? intersect(p.allowedModels, l.allowedModels) : p.allowedModels,
      escapeHatchAllowlist: l.escapeHatchAllowlist ? intersect(p.escapeHatchAllowlist, l.escapeHatchAllowlist) : p.escapeHatchAllowlist,
      registryAllowlist: l.registryAllowlist ? intersect(p.registryAllowlist, l.registryAllowlist) : p.registryAllowlist,
      protectedPaths: l.protectedPaths ? union(p.protectedPaths, l.protectedPaths) : p.protectedPaths,
      localOnly: p.localOnly || !!l.localOnly,
      maxDiffLines: Math.min(p.maxDiffLines, l.maxDiffLines ?? Infinity),
      retryBudget: Math.min(p.retryBudget, l.retryBudget ?? Infinity),
      waiverCap: Math.min(p.waiverCap, l.waiverCap ?? Infinity),
      minDiffCoverage: Math.max(p.minDiffCoverage, l.minDiffCoverage ?? 0),
      reviewConfidence: Math.min(p.reviewConfidence, l.reviewConfidence ?? Infinity), // lower = more findings block = stricter
      riskAutoProceed: l.riskAutoProceed && riskOrder[l.riskAutoProceed] < riskOrder[p.riskAutoProceed] ? l.riskAutoProceed : p.riskAutoProceed,
    };
  }
  return p;
}

export function modelAllowed(p: Policy, model: string): boolean {
  return p.allowedModels.includes("*") || p.allowedModels.includes(model);
}
