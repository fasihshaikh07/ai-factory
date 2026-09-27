// Mode manifests. Brownfield (stages-aligned §1).
import type { RunState } from "../ledger/state.js";
import { acceptStep, authorTestsStep, discoverStep, implementStep, integrateStep, stubCommitStep } from "./build.js";
import { deliverStep, reviewStep } from "./deliver.js";
import type { StepDef } from "./framework.js";
import { clarify2Step, clarifyStep } from "./clarify.js";
import { approveStep, groundStep, intakeStep, planStep } from "./spec.js";
import { draftsStep, mergeStep, specifyStep } from "./specpipe.js";

export function brownfieldSteps(state: RunState): StepDef[] {
  const tasks = (state.steps.get("plan")?.status === "completed" ? (state.steps.get("plan")!.data?.tasks as string[] | undefined) : undefined) ?? [];
  return [
    discoverStep, intakeStep, groundStep, clarifyStep, clarify2Step, draftsStep, mergeStep, specifyStep, planStep, approveStep,
    stubCommitStep, authorTestsStep,
    ...tasks.map((t) => implementStep(t)),
    integrateStep, acceptStep, reviewStep, deliverStep,
  ];
}
