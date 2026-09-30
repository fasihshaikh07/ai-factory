// Seeded-defect cases. Each case names a gate, an input, and what the gate must do with it.
//   must-fail  the defect is real: the gate has to catch it (a pass here is a MISS)
//   must-pass  the input is clean: the gate has to let it through (a fail here is a FALSE POSITIVE)
// Gates that aren't registered yet report "pending", so this file can grow ahead of the gates.
import type { DiffSummary } from "../../src/gates/predicates.js";
import {
  cleanFixture, dropTasksFor, goldPlate, maxSumsMin, openQuestion, outlier, silentOut, typedTotal,
  type EstimateFixture,
} from "./fixture.js";

export interface GateCase {
  id: string;
  gateId: string;
  description: string;
  expect: "must-fail" | "must-pass";
  input: unknown;
}

// ---------- existing gates: prove the harness on gates that already exist ----------

const diff = (paths: string[]): DiffSummary => ({
  from: "a", to: "b", files: paths.map((path) => ({ status: "M", path, added: [], removed: [] })), lockedNow: {},
});
const task = { fileScope: ["src/orders/**"] };

const existing: GateCase[] = [
  { id: "diff-in-scope/clean", gateId: "task.diff-in-scope", description: "change stays inside the task's file scope", expect: "must-pass", input: { diff: diff(["src/orders/list.ts"]), task } },
  { id: "diff-in-scope/outside", gateId: "task.diff-in-scope", description: "change touches a file outside the scope", expect: "must-fail", input: { diff: diff(["src/orders/list.ts", "src/billing/invoice.ts"]), task } },
  { id: "lock-set/clean", gateId: "task.lock-set-unchanged", description: "locked test file untouched", expect: "must-pass", input: { diff: { ...diff([]), lockedNow: { "t.test.ts": "s1" } }, tests: { lock: [{ file: "t.test.ts", sha: "s1" }] } } },
  { id: "lock-set/changed", gateId: "task.lock-set-unchanged", description: "locked test file edited", expect: "must-fail", input: { diff: { ...diff([]), lockedNow: { "t.test.ts": "s2" } }, tests: { lock: [{ file: "t.test.ts", sha: "s1" }] } } },
  { id: "lock-set/deleted", gateId: "task.lock-set-unchanged", description: "locked test file deleted", expect: "must-fail", input: { diff: { ...diff([]), lockedNow: { "t.test.ts": null } }, tests: { lock: [{ file: "t.test.ts", sha: "s1" }] } } },
];

// ---------- estimate gates (E1-E6): pending until they are built ----------
// The input is the provisional EstimateFixture. When a gate lands, adapt its cases' `input` to the real artifact.

const est = (id: string, gateId: string, description: string, expect: GateCase["expect"], input: EstimateFixture): GateCase => ({ id, gateId, description, expect, input });
const clean = cleanFixture();

const estimate: GateCase[] = [
  est("E1/clean", "E1", "spec has no open questions", "must-pass", clean),
  est("E1/open-question", "E1", "an open question remains", "must-fail", openQuestion(clean)),
  est("E2/clean", "E2", "every requirement has a task", "must-pass", clean),
  est("E2/dropped-requirement", "E2", "a requirement lost its only task", "must-fail", dropTasksFor("R3")(clean)),
  est("E3/clean", "E3", "every task cites a requirement or a named overhead", "must-pass", clean),
  est("E3/gold-plating", "E3", "a task with no requirement and no overhead", "must-fail", goldPlate(clean)),
  est("E4/clean", "E4", "every checklist item in, or out with a reason", "must-pass", clean),
  est("E4/silent-out", "E4", "an item marked out with no reason", "must-fail", silentOut(clean)),
  est("E5/clean", "E5", "similar tasks are within tolerance", "must-pass", clean),
  est("E5/outlier", "E5", "one screen is ten times its peers", "must-fail", outlier(clean)),
  est("E6/clean", "E6", "every total matches its rows", "must-pass", clean),
  est("E6/max-sums-min", "E6", "max total sums the min column", "must-fail", maxSumsMin(clean)),
  est("E6/typed-total", "E6", "a typed-in total that doesn't match its rows", "must-fail", typedTotal(clean)),
];

export const CASES: GateCase[] = [...existing, ...estimate];
