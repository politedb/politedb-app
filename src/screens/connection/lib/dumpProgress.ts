import type { DumpProgress } from "src/stores/dumpJob";

/**
 * Applies a progress update: steps and rows never go back, steps never
 * pass the total, and a missing total (0) means indeterminate. Pure.
 */
export function mergeProgress(
  prev: DumpProgress,
  update: Partial<DumpProgress>
): DumpProgress {
  const stepsTotal = Math.max(0, update.stepsTotal ?? prev.stepsTotal);
  const done = Math.max(prev.stepsDone, update.stepsDone ?? prev.stepsDone);
  return {
    stepsTotal,
    stepsDone: stepsTotal > 0 ? Math.min(done, stepsTotal) : Math.max(0, done),
    rows:
      update.rows === undefined
        ? prev.rows
        : Math.max(prev.rows ?? 0, update.rows),
    counts: update.counts ?? prev.counts,
    detail: "detail" in update ? update.detail : prev.detail,
  };
}

/** The bar's fraction, or null when indeterminate. */
export function progressFraction(progress: DumpProgress): number | null {
  if (progress.stepsTotal <= 0) return null;
  return Math.min(1, progress.stepsDone / progress.stepsTotal);
}

/**
 * Backup steps: per table one structure and one data step (empty and
 * generated-only tables count too), plus the types and post-data steps.
 */
export function backupStepsTotal(tables: number): number {
  return tables * 2 + 2;
}
