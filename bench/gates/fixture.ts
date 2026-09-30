// Provisional estimate fixture for seeding defects. The real Breakdown/Estimate artifacts don't exist
// yet (estimates-design.md, "Fit with the code"); when they land, replace this shape with the real one
// and keep the mutators. Every mutator returns a new object and never edits its input.

export interface Req { id: string; text: string; priority: "must" | "should" | "could" }
export interface Task { id: string; title: string; kind: string; reqIds: string[]; overhead?: string; min: number; max: number }
export interface ChecklistItem { item: string; status: "in" | "out"; reason?: string }
export interface Sheet { name: string; rows: { min: number; max: number }[]; totalMin: number; totalMax: number }

export interface EstimateFixture {
  specVersion: string;
  requirements: Req[];
  openQuestions: string[];
  tasks: Task[];
  checklist: ChecklistItem[];
  sheets: Sheet[];
}

const sheet = (name: string, rows: { min: number; max: number }[]): Sheet => ({
  name, rows,
  totalMin: rows.reduce((n, r) => n + r.min, 0),
  totalMax: rows.reduce((n, r) => n + r.max, 0),
});

/** A small, internally consistent estimate that every E-gate should pass. */
export function cleanFixture(): EstimateFixture {
  const tasks: Task[] = [
    { id: "EST-1", title: "Sign-in screen", kind: "screen", reqIds: ["R1"], min: 3, max: 4 },
    { id: "EST-2", title: "Sign-up screen", kind: "screen", reqIds: ["R2"], min: 3, max: 5 },
    { id: "EST-3", title: "Profile screen", kind: "screen", reqIds: ["R3"], min: 3, max: 4 },
    { id: "EST-4", title: "Auth endpoints", kind: "endpoint", reqIds: ["R1", "R2"], min: 6, max: 8 },
    { id: "EST-5", title: "Deployment to staging", kind: "overhead", reqIds: [], overhead: "deployment", min: 2, max: 3 },
  ];
  return {
    specVersion: "v1",
    requirements: [
      { id: "R1", text: "A user can sign in", priority: "must" },
      { id: "R2", text: "A user can sign up", priority: "must" },
      { id: "R3", text: "A user can view a profile", priority: "should" },
    ],
    openQuestions: [],
    tasks,
    checklist: [
      { item: "CI/CD", status: "in" },
      { item: "Monitoring", status: "out", reason: "Client hosts and monitors" },
      { item: "Accessibility", status: "in" },
    ],
    sheets: [sheet("Web", tasks.map((t) => ({ min: t.min, max: t.max })))],
  };
}

// ---------- mutators: each seeds exactly one defect ----------

/** E1: an unanswered question is still open. */
export const openQuestion = (f: EstimateFixture): EstimateFixture => ({ ...f, openQuestions: ["Is the admin portal web or mobile?"] });

/** E2: a requirement has no task (delete every task that cites it alone). */
export const dropTasksFor = (reqId: string) => (f: EstimateFixture): EstimateFixture => ({
  ...f, tasks: f.tasks.filter((t) => !(t.reqIds.length === 1 && t.reqIds[0] === reqId)),
});

/** E3: a task with no requirement and no named overhead (gold plating). */
export const goldPlate = (f: EstimateFixture): EstimateFixture => ({
  ...f, tasks: [...f.tasks, { id: "EST-99", title: "Animated onboarding tour", kind: "screen", reqIds: [], min: 8, max: 12 }],
});

/** E4: a checklist item marked out with no reason. */
export const silentOut = (f: EstimateFixture): EstimateFixture => ({
  ...f, checklist: f.checklist.map((c, i) => (i === 0 ? { item: c.item, status: "out" as const } : c)),
});

/** E5: one screen sized ten times its peers, with no explanation. */
export const outlier = (f: EstimateFixture): EstimateFixture => ({
  ...f, tasks: f.tasks.map((t) => (t.id === "EST-3" ? { ...t, min: 30, max: 40 } : t)),
});

/** E6: the sheet's max total sums the min column (a fault found in a reference workbook). */
export const maxSumsMin = (f: EstimateFixture): EstimateFixture => ({
  ...f, sheets: f.sheets.map((s) => ({ ...s, totalMax: s.rows.reduce((n, r) => n + r.min, 0) })),
});

/** E6: a typed-in total that no longer matches its rows. */
export const typedTotal = (f: EstimateFixture): EstimateFixture => ({
  ...f, sheets: f.sheets.map((s) => ({ ...s, totalMin: s.totalMin + 7 })),
});
