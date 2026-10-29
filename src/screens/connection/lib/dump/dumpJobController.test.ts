import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  admitClose,
  dismissDumpJobSummary,
  DUMP_JOB_CLOSE_REFUSED_MESSAGE,
  DUMP_JOB_CLOSING_MESSAGE,
  DUMP_JOB_RUNNING_MESSAGE,
  DUMP_JOB_SUMMARY_OPEN_MESSAGE,
  releaseCloseLease,
  useDumpJobStore,
  type DumpJobOrigin,
} from "src/stores/dumpJob";
import { useScreenStore } from "src/stores/screen";
import { mergeProgress, progressFraction } from "../dumpProgress";
import {
  cancelDumpJob,
  CleanupGroup,
  decideDumpJobStop,
  giveUpDumpJobCleanup,
  setDumpProgressScheduler,
  startDumpJob,
} from "./dumpJobController";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const origin: DumpJobOrigin = {
  tabId: "t1",
  runtimeConnectionId: "c1",
  engine: "postgres",
  target: "shop (shop_db)",
};

let frames: (() => void)[] = [];

beforeEach(() => {
  useDumpJobStore.setState({ active: null, summary: null, closing: [] });
  useScreenStore.setState({
    profileTabs: [
      { id: "t1", profileId: "p1", runtimeConnectionId: "c1" },
      { id: "t2", profileId: "p2", runtimeConnectionId: "c2" },
    ] as never,
  });
  frames = [];
  setDumpProgressScheduler((flush) => frames.push(flush));
});

function start(o: DumpJobOrigin = origin) {
  const started = startDumpJob("restore", o);
  if (!started.ok) throw new Error(started.message);
  return started.job;
}

describe("one dump job in the app", () => {
  it("refuses a second job, of any kind and any tab", () => {
    const job = start();
    expect(startDumpJob("backup", { ...origin, tabId: "t2" })).toEqual({
      ok: false,
      message: DUMP_JOB_RUNNING_MESSAGE,
    });
    expect(useDumpJobStore.getState().active?.jobId).toBe(job.jobId);
  });

  it("keeps a result to read until Close, refusing new jobs meanwhile", async () => {
    const job = start();
    await job.finish({ kind: "failed", message: "disk full" });
    expect(useDumpJobStore.getState().active).toBeNull();
    expect(useDumpJobStore.getState().summary?.jobId).toBe(job.jobId);
    expect(startDumpJob("restore", origin)).toEqual({
      ok: false,
      message: DUMP_JOB_SUMMARY_OPEN_MESSAGE,
    });
    // A stale Close does nothing.
    dismissDumpJobSummary("dump-stale");
    expect(useDumpJobStore.getState().summary).not.toBeNull();
    dismissDumpJobSummary(job.jobId);
    expect(start().jobId).not.toBe(job.jobId);
  });

  it("keeps no result for a success, an abandoned job or a cancelled backup", async () => {
    await start().finish({ kind: "succeeded", skipped: 0 });
    await start().finish({ kind: "abandoned" });
    const backup = startDumpJob("backup", origin);
    if (!backup.ok) throw new Error();
    await backup.job.finish({
      kind: "cancelled",
      rollback: "n/a",
      message: "Backup cancelled. No file was written.",
    });
    expect(useDumpJobStore.getState().summary).toBeNull();
  });

  it("is no longer current once its tab is gone or on another connection", () => {
    const job = start();
    expect(job.isCurrent()).toBe(true);
    useScreenStore.setState({
      profileTabs: [
        { id: "t1", profileId: "p1", runtimeConnectionId: "c9" },
      ] as never,
    });
    expect(job.isCurrent()).toBe(false);
    useScreenStore.setState({ profileTabs: [] });
    expect(job.isCurrent()).toBe(false);
  });

  it("is no longer current once its tab lost its runtime or a close of it was admitted", () => {
    const job = start();
    useScreenStore.setState({
      profileTabs: [{ id: "t1", profileId: "p1" }] as never,
    });
    expect(job.isCurrent()).toBe(false);
    useScreenStore.setState({
      profileTabs: [
        { id: "t1", profileId: "p1", runtimeConnectionId: "c1" },
      ] as never,
    });
    expect(job.isCurrent()).toBe(true);
    // A close covering it (admitted before the job registered its hold,
    // or by another path) makes a late prompt result stale.
    useDumpJobStore.setState({
      closing: [{ leaseId: 99, scope: { kind: "app" } }],
    });
    expect(job.isCurrent()).toBe(false);
  });

  it("releases the job only after its cleanup settled", async () => {
    const job = start();
    let release!: () => void;
    void job.cleanup.run(() => new Promise<void>((r) => (release = r)));
    const finishing = job.finish({ kind: "abandoned" });
    await Promise.resolve();
    expect(useDumpJobStore.getState().active?.jobId).toBe(job.jobId);
    expect(startDumpJob("backup", origin).ok).toBe(false);
    release();
    await finishing;
    expect(useDumpJobStore.getState().active).toBeNull();
  });
});

describe("close admission", () => {
  it("refuses closing the job's tab or the app, not another tab", () => {
    start();
    expect(admitClose({ kind: "tab", tabId: "t1" })).toEqual({
      ok: false,
      message: DUMP_JOB_CLOSE_REFUSED_MESSAGE,
    });
    expect(admitClose({ kind: "app" }).ok).toBe(false);
    expect(
      admitClose({ kind: "tab", tabId: "x", runtimeConnectionId: "c1" }).ok
    ).toBe(false);
    expect(admitClose({ kind: "tab", tabId: "t2" }).ok).toBe(true);
  });

  it("refuses a job whose origin a close covers, until every lease is released", () => {
    const a = admitClose({ kind: "app" });
    const b = admitClose({ kind: "tab", tabId: "t1" });
    if (!a.ok || !b.ok) throw new Error();
    expect(startDumpJob("restore", origin)).toEqual({
      ok: false,
      message: DUMP_JOB_CLOSING_MESSAGE,
    });
    releaseCloseLease(a.lease.leaseId);
    releaseCloseLease(a.lease.leaseId); // idempotent
    expect(startDumpJob("restore", origin).ok).toBe(false);
    releaseCloseLease(b.lease.leaseId);
    expect(startDumpJob("restore", origin).ok).toBe(true);
  });

  it("gives a nested call of the same close its caller's lease", () => {
    const intent = Symbol("close");
    const outer = admitClose({ kind: "tab", tabId: "t1" }, intent);
    const inner = admitClose({ kind: "tab", tabId: "t1" }, intent);
    const other = admitClose({ kind: "tab", tabId: "t1" });
    if (!outer.ok || !inner.ok || !other.ok) throw new Error();
    expect(inner.lease).toBe(outer.lease);
    expect(inner.owned).toBe(false);
    expect(other.lease.leaseId).not.toBe(outer.lease.leaseId);
    expect(useDumpJobStore.getState().closing).toHaveLength(2);
    // The independent close releasing early leaves the other's protection.
    releaseCloseLease(other.lease.leaseId);
    expect(startDumpJob("restore", origin).ok).toBe(false);
  });
});

describe("cancel", () => {
  it("does nothing while the phase cannot be cancelled", () => {
    const job = start();
    const action = vi.fn();
    job.setCancelAction(action);
    job.setPhase("committing", false);
    cancelDumpJob(job.jobId);
    expect(action).not.toHaveBeenCalled();
    expect(useDumpJobStore.getState().active?.cancel.kind).toBe("none");
  });

  it("runs the cancel action once, in the cleanup group, and records its evidence", async () => {
    const job = start();
    job.setPhase("running", true);
    let resolve!: (v: unknown) => void;
    const action = vi.fn(
      () =>
        new Promise<any>((r) => {
          resolve = r;
        })
    );
    job.setCancelAction(action);
    cancelDumpJob(job.jobId);
    cancelDumpJob(job.jobId); // coalesced
    expect(action).toHaveBeenCalledTimes(1);
    expect(job.stopRequested()).toBe(true);
    expect(job.cleanup.busy).toBe(true);
    resolve({ kind: "accepted", evidence: "not-committed-closed" });
    await job.cleanup.settled();
    await Promise.resolve();
    expect(useDumpJobStore.getState().active?.cancel.kind).toBe("accepted");
    expect(job.cleanup.evidence).toBe("not-committed-closed");
  });

  it("an acknowledged refusal stops nothing and disables cancel", async () => {
    const job = start();
    job.setPhase("running", true);
    job.setCancelAction(async () => ({
      kind: "refused",
      reason: "Committing",
    }));
    cancelDumpJob(job.jobId);
    await job.cleanup.settled();
    await Promise.resolve();
    const active = useDumpJobStore.getState().active!;
    expect(active.cancel).toEqual({ kind: "refused", reason: "Committing" });
    expect(active.cancellable).toBe(false);
    expect(job.stopRequested()).toBe(false);
  });

  it("offers a retry after a failed attempt; Cancel retries, Stop trying gives up", async () => {
    const job = start();
    job.setPhase("running", true);
    const retry = job.offerRetry("could not close");
    expect(useDumpJobStore.getState().active?.cancel).toEqual({
      kind: "failed",
      error: "could not close",
    });
    cancelDumpJob(job.jobId);
    expect(await retry).toBe("retry");
    expect(useDumpJobStore.getState().active?.cancel.kind).toBe("requested");

    const again = job.offerRetry("still not");
    giveUpDumpJobCleanup(job.jobId);
    expect(await again).toBe("stop");
  });

  it("asks one stop question at a time; a stale answer is ignored", async () => {
    const job = start();
    const counts = { completed: 2, skipped: 0, unknown: 0, total: 5 };
    const first = job.askStop(counts);
    const second = job.askStop(counts);
    const { decisionId } = useDumpJobStore.getState().active!.stopDecision!;
    decideDumpJobStop(job.jobId, decisionId + 99, true);
    expect(useDumpJobStore.getState().active?.stopDecision).not.toBeNull();
    decideDumpJobStop(job.jobId, decisionId, false);
    expect(await first).toBe(false);
    expect(await second).toBe(false);
    expect(useDumpJobStore.getState().active?.cancel.kind).toBe("none");
  });
});

describe("cleanup group", () => {
  it("keeps the strongest evidence and ignores results once sealed", () => {
    const g = new CleanupGroup();
    g.record("cleanup-unconfirmed");
    g.record("not-committed-closed");
    g.record("cleanup-unconfirmed");
    expect(g.evidence).toBe("not-committed-closed");
    g.record("rolled-back");
    g.seal();
    g.record("cleanup-unconfirmed");
    expect(g.evidence).toBe("rolled-back");
  });

  it("settles only when actions added meanwhile settled too", async () => {
    const g = new CleanupGroup();
    let second: Promise<void> | null = null;
    let release!: () => void;
    void g.run(async () => {
      second = g.run(() => new Promise<void>((r) => (release = r)));
    });
    let done = false;
    const settled = g.settled().then(() => (done = true));
    await Promise.resolve();
    await Promise.resolve();
    expect(second).not.toBeNull();
    expect(done).toBe(false);
    release();
    await settled;
    expect(done).toBe(true);
  });
});

describe("progress", () => {
  it("coalesces updates into one frame and drops them after the job ends", async () => {
    const job = start();
    job.progress({ stepsTotal: 10, stepsDone: 1 });
    job.progress({ stepsDone: 2, detail: "public.t" });
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(useDumpJobStore.getState().active?.progress).toMatchObject({
      stepsTotal: 10,
      stepsDone: 2,
      detail: "public.t",
    });
    job.progress({ stepsDone: 3 });
    await job.finish({ kind: "abandoned" });
    frames.shift()?.();
    expect(useDumpJobStore.getState().active).toBeNull();
  });

  it("never goes back, never passes the total, and is indeterminate without one", () => {
    const p = mergeProgress(
      { stepsDone: 5, stepsTotal: 10, rows: 100 },
      { stepsDone: 3, rows: 50 }
    );
    expect(p).toMatchObject({ stepsDone: 5, rows: 100 });
    expect(mergeProgress(p, { stepsDone: 99 }).stepsDone).toBe(10);
    expect(progressFraction({ stepsDone: 0, stepsTotal: 0 })).toBeNull();
    expect(progressFraction({ stepsDone: 3, stepsTotal: 4 })).toBe(0.75);
  });
});
