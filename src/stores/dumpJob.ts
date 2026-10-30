import { create } from "zustand";

/**
 * The one database backup, restore or SQL dump import running in the app
 * (D11), its retained result (D15), and the closes in progress that keep a
 * new job from starting (close admission). Plain state and synchronous
 * transitions only: the controller (screens/connection/lib/dump/
 * dumpJobController.ts) owns the running work.
 *
 * PoliteDB has a single webview window, so "the window" and "the app" are
 * the same close scope.
 */

export type DumpJobKind = "backup" | "restore" | "import";

/** Where a job was started, fixed when it is registered. */
export type DumpJobOrigin = {
  tabId: string;
  runtimeConnectionId: string;
  engine: string;
  /** What it runs on, for its title ("shop (shop_db)"). */
  target: string;
};

export type DumpPhase =
  // Before the modal (native prompts, D14)
  | "choosing-file"
  | "confirming"
  | "authenticating"
  // Backup
  | "preparing"
  | "structure"
  | "data"
  | "compressing"
  | "publishing"
  // Restore / import
  | "reading"
  | "checking"
  | "running"
  | "committing"
  | "refreshing";

/** Statements of a restore or import, by what became of them. */
export type DumpCounts = {
  completed: number;
  skipped: number;
  /** Failed by timeout or transport: may be partly applied. */
  unknown: number;
  total: number;
};

export type DumpProgress = {
  /** Monotonic, clamped to stepsTotal; 0 total = indeterminate. */
  stepsDone: number;
  stepsTotal: number;
  /** Backup: rows written so far. */
  rows?: number;
  counts?: DumpCounts;
  /** Table or statement now running; UI only, never logged. */
  detail?: string;
};

export type DumpCancelState =
  | { kind: "none" }
  | { kind: "requested" }
  | { kind: "accepted" }
  /** An acknowledged refusal (COMMIT or ROLLBACK already sent). */
  | { kind: "refused"; reason: string }
  /** No cancel attempt established evidence; retry or stop trying. */
  | { kind: "failed"; error: string };

/** What is known about a PostgreSQL transaction that was not committed. */
export type RollbackEvidence =
  | "nothing-run"
  | "rolled-back"
  | "not-committed-closed"
  | "cleanup-unconfirmed"
  | "n/a";

export type DumpOutcome =
  | {
      kind: "succeeded";
      skipped: number;
      /** Done, but a cleanup could not be confirmed (shown, kept). */
      warning?: string;
    }
  | {
      kind: "cancelled";
      rollback: RollbackEvidence;
      counts?: DumpCounts;
      /** A failure that came after the cancel was asked. */
      failure?: string;
      /** A catalog query could not be confirmed stopped (in `message`). */
      catalogUnconfirmed?: true;
      message: string;
    }
  | {
      kind: "stopped";
      reason: "safety" | "user";
      message: string;
      rollback?: RollbackEvidence;
      counts: DumpCounts;
    }
  | {
      kind: "failed";
      message: string;
      rollback?: RollbackEvidence;
      counts?: DumpCounts;
    }
  | { kind: "committed-refresh-failed"; message: string }
  | { kind: "commit-unknown"; message: string }
  | {
      kind: "temp-not-removed";
      after: "cancelled" | "failed";
      message?: string;
    }
  | { kind: "file-unconfirmed" }
  /** Ended quietly (a prompt dismissed, the origin gone). */
  | { kind: "abandoned" };

export type ActiveDumpJob = {
  jobId: string;
  kind: DumpJobKind;
  origin: DumpJobOrigin;
  phase: DumpPhase;
  progress: DumpProgress;
  cancel: DumpCancelState;
  /** Cancel can be asked now (not in COMMIT, publication or a prompt). */
  cancellable: boolean;
  /** A non-transactional run asking whether to stop (D10). */
  stopDecision: { decisionId: number; counts: DumpCounts } | null;
  /**
   * Its progress modal is shown: set by the run once its native prompts
   * (file dialog, confirmation, first Touch ID) are done (D14), and kept.
   */
  visible: boolean;
};

export type DumpJobSummary = {
  jobId: string;
  kind: DumpJobKind;
  origin: DumpJobOrigin;
  outcome: DumpOutcome;
};

/** What a close covers: one tab (its runtime connection) or the app. */
export type CloseScope =
  | { kind: "tab"; tabId: string; runtimeConnectionId?: string }
  | { kind: "app" };

export type CloseLease = {
  leaseId: number;
  scope: CloseScope;
  intent?: symbol;
};

type DumpJobState = {
  active: ActiveDumpJob | null;
  summary: DumpJobSummary | null;
  closing: CloseLease[];
};

export const useDumpJobStore = create<DumpJobState>(() => ({
  active: null,
  summary: null,
  closing: [],
}));

export function scopeCovers(scope: CloseScope, origin: DumpJobOrigin): boolean {
  if (scope.kind === "app") return true;
  return (
    scope.tabId === origin.tabId ||
    (!!scope.runtimeConnectionId &&
      scope.runtimeConnectionId === origin.runtimeConnectionId)
  );
}

export const DUMP_JOB_RUNNING_MESSAGE = "Another backup or restore is running.";
export const DUMP_JOB_SUMMARY_OPEN_MESSAGE =
  "Close the previous backup/restore result first.";
export const DUMP_JOB_CLOSING_MESSAGE =
  "This connection is closing, so no backup or restore can start.";
export const DUMP_JOB_CLOSE_REFUSED_MESSAGE =
  "A backup or restore is running. Cancel it and wait for it to finish, then close.";

/**
 * Registers a job in one synchronous transition: refused while another
 * job is active, a result is open, or a close covering its origin is in
 * progress.
 */
export function registerDumpJob(
  job: Pick<ActiveDumpJob, "jobId" | "kind" | "origin" | "phase">
): { ok: true } | { ok: false; message: string } {
  const s = useDumpJobStore.getState();
  if (s.active) return { ok: false, message: DUMP_JOB_RUNNING_MESSAGE };
  if (s.summary) return { ok: false, message: DUMP_JOB_SUMMARY_OPEN_MESSAGE };
  if (s.closing.some((lease) => scopeCovers(lease.scope, job.origin))) {
    return { ok: false, message: DUMP_JOB_CLOSING_MESSAGE };
  }
  useDumpJobStore.setState({
    active: {
      ...job,
      progress: { stepsDone: 0, stepsTotal: 0 },
      cancel: { kind: "none" },
      cancellable: false,
      stopDecision: null,
      visible: false,
    },
  });
  return { ok: true };
}

/** Changes the active job, if it is still `jobId`. */
export function updateDumpJob(
  jobId: string,
  change: (job: ActiveDumpJob) => Partial<ActiveDumpJob>
): void {
  const { active } = useDumpJobStore.getState();
  if (!active || active.jobId !== jobId) return;
  useDumpJobStore.setState({ active: { ...active, ...change(active) } });
}

/**
 * Ends the active job `jobId` in one transition: it is no longer active,
 * and its result is kept when it must be read.
 */
export function finishDumpJob(
  jobId: string,
  summary: DumpJobSummary | null
): void {
  const { active } = useDumpJobStore.getState();
  if (!active || active.jobId !== jobId) return;
  useDumpJobStore.setState({ active: null, summary });
}

/** Closes the retained result `jobId` (a stale Close does nothing). */
export function dismissDumpJobSummary(jobId: string): void {
  const { summary } = useDumpJobStore.getState();
  if (summary?.jobId !== jobId) return;
  useDumpJobStore.setState({ summary: null });
}

let nextLeaseId = 1;

/**
 * Admits a close in one synchronous transition: refused while an active
 * job's origin is in scope; otherwise a lease that keeps matching jobs
 * from starting until released. A nested call carrying the same intent
 * that already holds a lease covering the scope gets that lease back
 * (and must not release it).
 */
export function admitClose(
  scope: CloseScope,
  intent?: symbol
):
  | { ok: true; lease: CloseLease; owned: boolean }
  | { ok: false; message: string } {
  const s = useDumpJobStore.getState();
  if (s.active && scopeCovers(scope, s.active.origin)) {
    return { ok: false, message: DUMP_JOB_CLOSE_REFUSED_MESSAGE };
  }
  if (intent) {
    const held = s.closing.find(
      (lease) =>
        lease.intent === intent &&
        (lease.scope.kind === "app" ||
          (scope.kind === "tab" &&
            lease.scope.kind === "tab" &&
            lease.scope.tabId === scope.tabId))
    );
    if (held) return { ok: true, lease: held, owned: false };
  }
  const lease: CloseLease = { leaseId: nextLeaseId++, scope, intent };
  useDumpJobStore.setState({ closing: [...s.closing, lease] });
  return { ok: true, lease, owned: true };
}

/** Releases one lease (idempotent); other leases stay. */
export function releaseCloseLease(leaseId: number): void {
  const { closing } = useDumpJobStore.getState();
  if (!closing.some((lease) => lease.leaseId === leaseId)) return;
  useDumpJobStore.setState({
    closing: closing.filter((lease) => lease.leaseId !== leaseId),
  });
}
