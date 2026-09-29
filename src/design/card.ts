// The design step's line on the approval card: the size of the UI change, from the plan's
// file list, before any code exists. No UI → no line, so non-UI runs see no change.
import { detectLayout, depsOf } from "./layout.js";
import { plannedChanges, sizeChange, type SizeResult } from "./size.js";
import { dirSource } from "./source.js";

export function planUiSize(snapshotRoot: string, snapshotFiles: string[], fileScope: string[]): SizeResult {
  const src = dirSource(snapshotRoot);
  const listed = { list: () => snapshotFiles, read: src.read };
  const deps = depsOf(listed);
  const layout = deps.react || deps.next ? detectLayout(listed) : undefined;
  return sizeChange({ files: plannedChanges(fileScope, snapshotFiles, layout) }, layout ? { layout } : {});
}

/** One markdown line for the card, or undefined when the plan touches no UI. */
export function uiSizeCardLine(size: SizeResult): string | undefined {
  if (size.level === "none") return undefined;
  const why = size.reasons.filter((r) => r.startsWith(size.name)).slice(0, 2).map((r) => r.slice(size.name.length + 2)).join("; ");
  return `UI size: **${size.name}** (${why}). Design work: ${size.work}.`;
}
