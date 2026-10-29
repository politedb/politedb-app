import {
  finishDumpJob,
  registerDumpJob,
  scopeCovers,
  updateDumpJob,
  useDumpJobStore,
  type DumpCounts,
  type DumpJobKind,
  type DumpJobOrigin,
  type DumpOutcome,
  type DumpPhase,
  type DumpProgress,
  type RollbackEvidence,
} from "src/stores/dumpJob";
import { useScreenStore } from "src/stores/screen";
import { mergeProgress } from "../dumpProgress";

/**
 * Owns the running dump job's control (cancel, its cleanup, the stop
 * decision of a non-transactional run) outside any component, so the
 * modal, the menu and the close guard all act on the same job, and a job
 * survives the component that started it. State lives in useDumpJobStore.
 */

/** Strongest first: what most surely says nothing was committed. */
const EVIDENCE_STRENGTH: Record<RollbackEvidence, number> = {
  "rolled-back": 3,
  "not-committed-closed": 2,
  "cleanup-unconfirmed": 1,
  "nothing-run": 0,
  "n/a": 0,
};

/**
 * Every cleanup action of one job (a cancel, its fallback, a retry, the
 * adoption of a late resource): registered before it starts, one at a
 * time, and awaited before the job ends. The strongest evidence any of
 * them established wins; once sealed, late results are ignored.
 */
export class CleanupGroup {
  private pending = new Set<Promise<unknown>>();
  private best: RollbackEvidence | null = null;
  private sealed = false;

  get busy(): boolean {
    return this.pending.size > 0;
  }

  get evidence(): RollbackEvidence | null {
    return this.best;
  }

  record(evidence: RollbackEvidence | null): void {
    if (this.sealed || !evidence) return;
    if (
      !this.best ||
      EVIDENCE_STRENGTH[evidence] > EVIDENCE_STRENGTH[this.best]
    ) {
      this.best = evidence;
    }
  }

  /** Runs `action` as a member of the group. */
  run<T>(action: () => Promise<T>): Promise<T> {
    const work = action();
    this.pending.add(work);
    const done = () => this.pending.delete(work);
    work.then(done, done);
    return work;
  }

  /** Resolves once no action is pending (also ones added meanwhile). */
  async settled(): Promise<void> {
    while (this.pending.size) {
      await Promise.allSettled([...this.pending]);
    }
  }

  seal(): void {
    this.sealed = true;
  }

  get isSealed(): boolean {
    return this.sealed;
  }
}

/** What the run's current cancel action established. */
export type CancelActionResult =
  | { kind: "accepted"; evidence: RollbackEvidence | null }
  | { kind: "refused"; reason: string }
  | { kind: "failed"; error: string };

export type DumpJobHandle = {
  readonly jobId: string;
  readonly kind: DumpJobKind;
  readonly origin: DumpJobOrigin;
  readonly cleanup: CleanupGroup;
  /** Still the active job, and its origin tab still on its connection. */
  isCurrent(): boolean;
  /** A cancel was asked (and not refused): start no new work. */
  stopRequested(): boolean;
  setPhase(phase: DumpPhase, cancellable: boolean): void;
  progress(update: Partial<DumpProgress>): void;
  /** What Cancel does now (null: the run stops at its next check). */
  setCancelAction(action: (() => Promise<CancelActionResult>) | null): void;
  /** D10: asks whether to stop after the statement that just settled. */
  askStop(counts: DumpCounts): Promise<boolean>;
  /** No cancel attempt established evidence: retry, or stop trying. */
  offerRetry(error: string): Promise<"retry" | "stop">;
  /** Ends the job (after its cleanup settled); keeps results to read. */
  finish(outcome: DumpOutcome): Promise<void>;
};

type Control = {
  handle: DumpJobHandle;
  cancelAction: (() => Promise<CancelActionResult>) | null;
  stopDecision: {
    decisionId: number;
    resolve: (stop: boolean) => void;
  } | null;
  retryDecision: ((choice: "retry" | "stop") => void) | null;
  pendingProgress: Partial<DumpProgress> | null;
  progressScheduled: boolean;
};

let control: Control | null = null;
let nextJobId = 1;
let nextDecisionId = 1;

type Scheduler = (flush: () => void) => void;
let scheduleProgress: Scheduler = (flush) =>
  typeof requestAnimationFrame === "function"
    ? requestAnimationFrame(() => flush())
    : setTimeout(flush, 16);

/** Tests replace the frame scheduler (progress updates coalesce on it). */
export function setDumpProgressScheduler(scheduler: Scheduler): void {
  scheduleProgress = scheduler;
}

function current(jobId: string): Control | null {
  return control && control.handle.jobId === jobId ? control : null;
}

function flushProgress(c: Control) {
  c.progressScheduled = false;
  const update = c.pendingProgress;
  c.pendingProgress = null;
  if (!update) return;
  updateDumpJob(c.handle.jobId, (job) => ({
    progress: mergeProgress(job.progress, update),
  }));
}

/** Outcomes the user must read stay in the modal until Close (D15). */
function mustRead(kind: DumpJobKind, outcome: DumpOutcome): boolean {
  switch (outcome.kind) {
    case "succeeded":
      return !!outcome.warning;
    case "abandoned":
      return false;
    case "cancelled":
      // A cancelled backup closes quietly with a toast (D12), unless
      // something about it must be read.
      return (
        kind !== "backup" ||
        !!outcome.failure ||
        outcome.rollback === "cleanup-unconfirmed"
      );
    default:
      return true;
  }
}

/**
 * Registers a job (D11): refused while another job is active, a result is
 * open, or a close covering `origin` is in progress.
 */
export function startDumpJob(
  kind: DumpJobKind,
  origin: DumpJobOrigin,
  phase: DumpPhase = "choosing-file"
): { ok: true; job: DumpJobHandle } | { ok: false; message: string } {
  const jobId = `dump-${nextJobId++}`;
  const registered = registerDumpJob({ jobId, kind, origin, phase });
  if (!registered.ok) return registered;

  const cleanup = new CleanupGroup();
  let finished = false;
  const handle: DumpJobHandle = {
    jobId,
    kind,
    origin,
    cleanup,
    isCurrent() {
      if (finished || !current(jobId)) return false;
      // The origin tab, on the very runtime connection it had…
      const tab = useScreenStore
        .getState()
        .profileTabs.find((t) => t.id === origin.tabId);
      if (!tab || tab.runtimeConnectionId !== origin.runtimeConnectionId) {
        return false;
      }
      // …and no close of it admitted meanwhile.
      return !useDumpJobStore
        .getState()
        .closing.some((lease) => scopeCovers(lease.scope, origin));
    },
    stopRequested() {
      const job = useDumpJobStore.getState().active;
      if (!job || job.jobId !== jobId) return true;
      return job.cancel.kind !== "none" && job.cancel.kind !== "refused";
    },
    setPhase(phase, cancellable) {
      updateDumpJob(jobId, () => ({ phase, cancellable }));
    },
    progress(update) {
      const c = current(jobId);
      if (!c || finished) return;
      c.pendingProgress = { ...(c.pendingProgress ?? {}), ...update };
      if (c.progressScheduled) return;
      c.progressScheduled = true;
      scheduleProgress(() => {
        const now = current(jobId);
        if (now && !finished) flushProgress(now);
      });
    },
    setCancelAction(action) {
      const c = current(jobId);
      if (c) c.cancelAction = action;
    },
    askStop(counts) {
      const c = current(jobId);
      if (!c) return Promise.resolve(true);
      if (c.stopDecision) {
        // One decision at a time: a repeated ask joins it.
        return new Promise((resolve) => {
          const prev = c.stopDecision!.resolve;
          c.stopDecision!.resolve = (stop) => {
            prev(stop);
            resolve(stop);
          };
        });
      }
      const decisionId = nextDecisionId++;
      return new Promise<boolean>((resolve) => {
        c.stopDecision = { decisionId, resolve };
        updateDumpJob(jobId, () => ({ stopDecision: { decisionId, counts } }));
      });
    },
    offerRetry(error) {
      const c = current(jobId);
      if (!c) return Promise.resolve("stop");
      return new Promise((resolve) => {
        c.retryDecision = resolve;
        updateDumpJob(jobId, () => ({
          cancel: { kind: "failed", error },
          cancellable: true,
        }));
      });
    },
    async finish(outcome) {
      if (finished) return;
      await cleanup.settled();
      cleanup.seal();
      const c = current(jobId);
      if (c) flushProgress(c);
      finished = true;
      if (control?.handle.jobId === jobId) control = null;
      finishDumpJob(
        jobId,
        mustRead(kind, outcome) ? { jobId, kind, origin, outcome } : null
      );
    },
  };
  control = {
    handle,
    cancelAction: null,
    stopDecision: null,
    retryDecision: null,
    pendingProgress: null,
    progressScheduled: false,
  };
  return { ok: true, job: handle };
}

/**
 * Cancel pressed for `jobId`. Ignored while a cancel is pending, refused,
 * or the phase cannot be cancelled. After a failed attempt it is the
 * retry (D: cleanup attempts never overlap).
 */
export function cancelDumpJob(jobId: string): void {
  const c = current(jobId);
  const job = useDumpJobStore.getState().active;
  if (!c || !job || job.jobId !== jobId || !job.cancellable) return;

  if (job.cancel.kind === "failed") {
    // A retry waits until every earlier attempt settled (never overlap).
    if (c.handle.cleanup.busy) return;
    const retry = c.retryDecision;
    c.retryDecision = null;
    updateDumpJob(jobId, () => ({ cancel: { kind: "requested" } }));
    retry?.("retry");
    return;
  }
  if (job.cancel.kind !== "none") return;

  updateDumpJob(jobId, () => ({ cancel: { kind: "requested" } }));
  const action = c.cancelAction;
  if (!action) return;
  void c.handle.cleanup
    .run(action)
    .catch(
      (error): CancelActionResult => ({
        kind: "failed",
        error: error instanceof Error ? error.message : String(error),
      })
    )
    .then((result) => {
      if (!current(jobId)) return;
      if (result.kind === "accepted") {
        c.handle.cleanup.record(result.evidence);
        updateDumpJob(jobId, () => ({ cancel: { kind: "accepted" } }));
      } else if (result.kind === "refused") {
        updateDumpJob(jobId, () => ({
          cancel: { kind: "refused", reason: result.reason },
          cancellable: false,
        }));
      }
      // "failed": stays requested; the run takes its fallback.
    });
}

/** The user answered a D10 stop question (a stale decision is ignored). */
export function decideDumpJobStop(
  jobId: string,
  decisionId: number,
  stop: boolean
): void {
  const c = current(jobId);
  if (!c?.stopDecision || c.stopDecision.decisionId !== decisionId) return;
  const { resolve } = c.stopDecision;
  c.stopDecision = null;
  updateDumpJob(jobId, () => ({
    stopDecision: null,
    cancel: stop ? { kind: "accepted" } : { kind: "none" },
  }));
  resolve(stop);
}

/** "Stop trying" after failed cancel attempts. */
export function giveUpDumpJobCleanup(jobId: string): void {
  const c = current(jobId);
  if (!c?.retryDecision) return;
  const decide = c.retryDecision;
  c.retryDecision = null;
  updateDumpJob(jobId, () => ({ cancellable: false }));
  decide("stop");
}

/** The active job's handle (tests, the close guard). */
export function activeDumpJob(): DumpJobHandle | null {
  return control?.handle ?? null;
}
