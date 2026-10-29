import { useEffect, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import {
  dismissDumpJobSummary,
  useDumpJobStore,
  type ActiveDumpJob,
  type DumpCounts,
  type DumpJobKind,
  type DumpJobSummary,
  type DumpPhase,
} from "src/stores/dumpJob";
import {
  cancelDumpJob,
  decideDumpJobStop,
  giveUpDumpJobCleanup,
} from "src/screens/connection/lib/dump/dumpJobController";
import { describeDumpOutcome } from "src/screens/connection/lib/dump/dumpOutcomeText";
import { progressFraction } from "src/screens/connection/lib/dumpProgress";
import { cn } from "src/utils/cn";

/**
 * The running database backup, restore or SQL dump import (one in the
 * app), then its result when it must be read (D15). It shows nothing while
 * the job's native prompts (file dialog, confirmation, Touch ID) come
 * first (D14), and ignores Esc, × and outside clicks while the job runs:
 * only Cancel cancels (D12). Presentational: the controller does the work.
 */

/** Phases before the modal opens: the native prompts are the way out. */
const PROMPT_PHASES: ReadonlySet<DumpPhase> = new Set([
  "choosing-file",
  "confirming",
  "authenticating",
]);

const PHASE_TEXT: Record<DumpPhase, string> = {
  "choosing-file": "Choosing the file…",
  confirming: "Waiting for confirmation…",
  authenticating: "Waiting for Touch ID…",
  preparing: "Preparing…",
  structure: "Reading table structure…",
  data: "Reading rows…",
  compressing: "Compressing…",
  publishing: "Writing the file…",
  reading: "Reading the file…",
  checking: "Checking the database…",
  running: "Running statements…",
  committing: "Committing…",
  refreshing: "Refreshing the schema…",
};

function title(kind: DumpJobKind, target: string): string {
  const into = target ? ` ${target}` : "";
  if (kind === "backup") return `Backing up${into}`;
  if (kind === "restore") return `Restoring into${into}`;
  return `Importing into${into}`;
}

function summaryTitle(kind: DumpJobKind): string {
  if (kind === "backup") return "Backup";
  if (kind === "restore") return "Restore";
  return "Import";
}

function countsText(counts: DumpCounts): string {
  const parts = [`${counts.completed} of ${counts.total} ran`];
  if (counts.skipped) parts.push(`${counts.skipped} skipped`);
  if (counts.unknown) parts.push(`${counts.unknown} may be partly applied`);
  return parts.join(" · ");
}

/** Why Cancel cannot be pressed now, or null when it can. */
function cancelBlocked(job: ActiveDumpJob): string | null {
  if (job.phase === "committing") {
    return "Committing: this can no longer be cancelled.";
  }
  if (job.phase === "publishing") {
    return "Writing the file: this can no longer be cancelled.";
  }
  if (job.cancel.kind === "refused") return job.cancel.reason;
  if (!job.cancellable) return "This step cannot be cancelled.";
  return null;
}

function RunningJob({ job }: { job: ActiveDumpJob }) {
  const fraction = progressFraction(job.progress);
  const pct = fraction === null ? null : Math.round(fraction * 100);
  const { counts, rows, detail } = job.progress;
  const blocked = cancelBlocked(job);
  const cancelling =
    job.cancel.kind === "requested" || job.cancel.kind === "accepted";
  const status = cancelling
    ? job.phase === "compressing"
      ? "Cancelling — waiting for compression to finish…"
      : "Cancelling…"
    : PHASE_TEXT[job.phase];

  return (
    <>
      <DialogHeader className="shrink-0 border-b border-neutral-200 pr-4">
        <DialogTitle>{title(job.kind, job.origin.target)}</DialogTitle>
        <DialogDescription className="dark:text-neutral-400">
          {status}
        </DialogDescription>
      </DialogHeader>
      <DialogContent className="flex flex-col gap-3">
        <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
          <div
            class={cn(
              "h-full rounded-full bg-blue-500",
              pct === null
                ? "w-1/3 animate-pulse"
                : "transition-[width] duration-300 ease-out"
            )}
            style={pct === null ? undefined : { width: `${pct}%` }}
            role="progressbar"
            aria-label="Progress"
            aria-busy={true}
            {...(pct === null
              ? {}
              : {
                  "aria-valuenow": pct,
                  "aria-valuemin": 0,
                  "aria-valuemax": 100,
                })}
          />
        </div>
        <div class="flex min-w-0 items-center justify-between gap-2 text-xs text-neutral-600 dark:text-neutral-300">
          <span class="min-w-0 truncate" title={detail}>
            {detail ?? ""}
          </span>
          <span class="shrink-0 tabular-nums">
            {counts
              ? countsText(counts)
              : job.progress.stepsTotal > 0
                ? `${job.progress.stepsDone} / ${job.progress.stepsTotal}`
                : ""}
            {rows !== undefined ? ` · ${rows.toLocaleString()} rows` : ""}
          </span>
        </div>

        {job.stopDecision ? (
          <div
            role="alertdialog"
            aria-label="Stop here?"
            class="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
          >
            <p>
              {job.stopDecision.counts.completed} of{" "}
              {job.stopDecision.counts.total} statements ran and stay in the
              database
              {job.stopDecision.counts.skipped
                ? ` (${job.stopDecision.counts.skipped} skipped)`
                : ""}
              {job.stopDecision.counts.unknown
                ? `; ${job.stopDecision.counts.unknown} may be partly applied`
                : ""}
              . Stop here?
            </p>
            <div class="mt-2 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() =>
                  decideDumpJobStop(
                    job.jobId,
                    job.stopDecision!.decisionId,
                    false
                  )
                }
              >
                Continue
              </Button>
              <Button
                variant="default"
                onClick={() =>
                  decideDumpJobStop(
                    job.jobId,
                    job.stopDecision!.decisionId,
                    true
                  )
                }
              >
                Stop
              </Button>
            </div>
          </div>
        ) : null}

        {job.cancel.kind === "failed" ? (
          <div
            role="alert"
            class="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-700 dark:bg-red-950 dark:text-red-100"
          >
            {job.cancel.error} Try again, or stop trying (the run then ends
            without confirming it).
          </div>
        ) : null}
        {blocked && !cancelling && job.cancel.kind !== "failed" ? (
          <p class="text-xs text-neutral-500">{blocked}</p>
        ) : null}
      </DialogContent>
      <DialogFooter className="shrink-0 justify-end gap-2">
        {job.cancel.kind === "failed" ? (
          <>
            <Button
              variant="outline"
              onClick={() => giveUpDumpJobCleanup(job.jobId)}
            >
              Stop trying
            </Button>
            <Button variant="default" onClick={() => cancelDumpJob(job.jobId)}>
              Try again
            </Button>
          </>
        ) : (
          <Button
            variant="outline"
            disabled={!!blocked || cancelling || !!job.stopDecision}
            title={blocked ?? undefined}
            onClick={() => cancelDumpJob(job.jobId)}
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}

function JobSummary({ summary }: { summary: DumpJobSummary }) {
  const text = describeDumpOutcome(summary.outcome);
  const close = () => dismissDumpJobSummary(summary.jobId);
  return (
    <>
      <DialogHeader className="shrink-0 border-b border-neutral-200">
        <DialogTitle>{summaryTitle(summary.kind)}</DialogTitle>
        {summary.origin.target ? (
          <DialogDescription className="dark:text-neutral-400">
            {summary.origin.target}
          </DialogDescription>
        ) : null}
      </DialogHeader>
      <DialogContent>
        <p
          role={text?.tone === "error" ? "alert" : "status"}
          class={cn(
            "text-sm wrap-break-word whitespace-pre-wrap",
            text?.tone === "error"
              ? "text-red-700 dark:text-red-300"
              : text?.tone === "warning"
                ? "text-amber-800 dark:text-amber-200"
                : "text-neutral-800 dark:text-neutral-200"
          )}
        >
          {text?.message ?? ""}
        </p>
      </DialogContent>
      <DialogFooter className="shrink-0 justify-end">
        <Button variant="default" onClick={close}>
          Close
        </Button>
      </DialogFooter>
    </>
  );
}

export function DumpProgressDialog() {
  const active = useDumpJobStore((s) => s.active);
  const summary = useDumpJobStore((s) => s.summary);

  // Once shown, a job stays shown (a Touch ID asked mid-run included).
  const [shownJob, setShownJob] = useState<string | null>(null);
  const showActive =
    !!active && (shownJob === active.jobId || !PROMPT_PHASES.has(active.phase));
  useEffect(() => {
    if (showActive && active && shownJob !== active.jobId) {
      setShownJob(active.jobId);
    }
  }, [showActive, active, shownJob]);

  if (showActive && active) {
    return (
      <Dialog
        open
        size="sm"
        showCloseButton={false}
        closeOnOutsideClick={false}
        closeOnEsc={false}
        className="mx-auto flex w-full flex-col overflow-hidden"
      >
        <RunningJob job={active} />
      </Dialog>
    );
  }
  if (summary) {
    return (
      <Dialog
        open
        size="sm"
        onClose={() => dismissDumpJobSummary(summary.jobId)}
        closeOnOutsideClick={false}
        className="mx-auto flex w-full flex-col overflow-hidden"
      >
        <JobSummary summary={summary} />
      </Dialog>
    );
  }
  return null;
}
