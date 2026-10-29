import { useEffect, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
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
        <DialogTitle>
          <span id={TITLE_ID}>{title(job.kind, job.origin.target)}</span>
        </DialogTitle>
        <DialogDescription className="dark:text-neutral-400">
          <span id={DESCRIPTION_ID} aria-live="polite">
            {status}
          </span>
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
        <DialogTitle>
          <span id={TITLE_ID}>{summaryTitle(summary.kind)}</span>
        </DialogTitle>
        {summary.origin.target ? (
          <DialogDescription className="dark:text-neutral-400">
            {summary.origin.target}
          </DialogDescription>
        ) : null}
      </DialogHeader>
      <DialogContent>
        <p
          id={DESCRIPTION_ID}
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

const TITLE_ID = "dump-progress-title";
const DESCRIPTION_ID = "dump-progress-description";

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Makes the modal really modal while it is open: the app behind it is
 * inert (no focus, no click), focus moves into it and Tab stays in it,
 * app shortcuts do not reach the app behind it, and focus returns to
 * where it was when it closes.
 */
function useModalFocus(open: boolean, container: HTMLElement | null) {
  useEffect(() => {
    if (!open || !container) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const root = document.getElementById("root");
    const wasInert = root?.inert ?? false;
    if (root) root.inert = true;

    const panel = container.querySelector<HTMLElement>('[role="dialog"]');
    if (panel) {
      panel.setAttribute("aria-labelledby", TITLE_ID);
      panel.setAttribute("aria-describedby", DESCRIPTION_ID);
      panel.tabIndex = -1;
    }
    const focusables = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
    (focusables()[0] ?? panel)?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Tab") {
        const items = focusables();
        if (!items.length) {
          e.preventDefault();
          panel?.focus();
          return;
        }
        const first = items[0]!;
        const last = items[items.length - 1]!;
        const inside = container.contains(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === first)) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (!inside || document.activeElement === last)
        ) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      // App shortcuts (save, close tab, run…) must not act behind it.
      if (e.metaKey || e.ctrlKey || e.altKey) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      if (root) root.inert = wasInert;
      if (opener?.isConnected) opener.focus();
    };
  }, [open, container]);
}

export function DumpProgressDialog() {
  const active = useDumpJobStore((s) => s.active);
  const summary = useDumpJobStore((s) => s.summary);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  // Shown once its run reported its native prompts done (D14).
  const showActive = !!active?.visible;
  const open = showActive || !!summary;
  useModalFocus(open, container);

  if (!open) return null;
  return createPortal(
    <div ref={setContainer}>
      {showActive && active ? (
        <Dialog
          open
          size="sm"
          showCloseButton={false}
          closeOnOutsideClick={false}
          closeOnEsc={false}
          className="mx-auto flex w-full flex-col"
        >
          <RunningJob job={active} />
        </Dialog>
      ) : summary ? (
        <Dialog
          open
          size="sm"
          onClose={() => dismissDumpJobSummary(summary.jobId)}
          closeOnOutsideClick={false}
          className="mx-auto flex w-full flex-col"
        >
          <JobSummary summary={summary} />
        </Dialog>
      ) : null}
    </div>,
    document.body
  );
}
