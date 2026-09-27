// Mode manifests. Brownfield thin slice (stages-aligned §1); clarify, 3-draft merge and
// round trip are added after the slice works end to end.
import type { RunState } from "../ledger/state.js";
import { acceptStep, authorTestsStep, discoverStep, implementStep, integrateStep, stubCommitStep } from "./build.js";
import { deliverStep, reviewStep } from "./deliver.js";
import type { StepDef } from "./framework.js";
import { approveStep, criticStep, groundStep, intakeStep, planStep, specifyStep } from "./spec.js";

export function brownfieldSteps(state: RunState): StepDef[] {
  const tasks = (state.steps.get("plan")?.status === "completed" ? (state.steps.get("plan")!.data?.tasks as string[] | undefined) : undefined) ?? [];
  return [
    discoverStep, intakeStep, groundStep, specifyStep, criticStep, planStep, approveStep,
    stubCommitStep, authorTestsStep,
    ...tasks.map((t) => implementStep(t)),
    integrateStep, acceptStep, reviewStep, deliverStep,
  ];
}
