import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/preact";
import { useDbHealthInspector } from "./useDbHealthInspector";
import { useLicenseStore } from "src/stores/license";
import type { LicenseState } from "src/lib/tauri/license";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";
import { useScreenStore } from "src/stores/screen";

const collectMock = vi.fn();

vi.mock("src/lib/tauri/health-inspector", () => ({
  collectHealthInspectorSnapshot: (...args: any[]) => collectMock(...args),
}));

const signalMock = vi.fn();
vi.mock("src/lib/tauri/health-inspector-actions", () => ({
  signalHealthInspectorBackend: (...args: any[]) => signalMock(...args),
}));

const trackMock = vi.fn();
vi.mock("src/lib/analytics", () => ({
  trackHealthInspectorSessionAction: (...args: any[]) => trackMock(...args),
}));

function snap(partial?: Record<string, unknown>) {
  return {
    runtimeConnectionId: "c1",
    profileId: "p1",
    tabId: "tab-1",
    engine: "postgres",
    startedAt: 1,
    finishedAt: 2,
    overallError: null,
    cancelled: false,
    overview: {
      status: "ready",
      collectedAt: 2,
      error: null,
      truncated: false,
      unavailableReason: null,
      data: null,
    },
    sessions: {
      status: "empty",
      collectedAt: 2,
      error: null,
      truncated: false,
      unavailableReason: null,
      data: [],
    },
    statements: {
      status: "unavailable",
      collectedAt: 2,
      error: null,
      truncated: false,
      unavailableReason: "missing",
      data: [],
      info: null,
    },
    tables: {
      status: "empty",
      collectedAt: 2,
      error: null,
      truncated: false,
      unavailableReason: null,
      data: [],
    },
    indexes: {
      status: "empty",
      collectedAt: 2,
      error: null,
      truncated: false,
      unavailableReason: null,
      data: [],
    },
    ...partial,
  };
}

function setProAccess(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

const pgCtx = {
  open: true,
  runtimeConnectionId: "c1",
  profileId: "p1",
  tabId: "tab-1",
  engine: "postgres" as const,
};

beforeEach(() => {
  resetTabRuntimes();
  seedTabRuntime({ tabId: "tab-1", runtimeId: "c1" });
  setProAccess(true);
  collectMock.mockReset();
  collectMock.mockResolvedValue(snap());
});

describe("useDbHealthInspector lifecycle", () => {
  it("loads once on open and clears on close", async () => {
    const { result, rerender } = renderHook(
      (props: any) => useDbHealthInspector(props),
      {
        initialProps: {
          open: true,
          runtimeConnectionId: "c1",
          profileId: "p1",
          tabId: "tab-1",
          engine: "postgres" as const,
        },
      }
    );

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(collectMock).toHaveBeenCalledTimes(1);

    rerender({
      open: false,
      runtimeConnectionId: "c1",
      profileId: "p1",
      tabId: "tab-1",
      engine: "postgres",
    });

    await waitFor(() => expect(result.current.snapshot).toBeNull());
  });

  it("double refresh aborts the first in-flight request", async () => {
    let firstSignal: AbortSignal | undefined;
    collectMock.mockImplementation(async (args: any) => {
      if (!firstSignal) firstSignal = args.signal;
      await new Promise((r) => setTimeout(r, 30));
      return snap({
        runtimeConnectionId: args.runtimeConnectionId,
        cancelled: !!args.signal?.aborted,
      });
    });

    const { result } = renderHook(() =>
      useDbHealthInspector({
        open: true,
        runtimeConnectionId: "c1",
        profileId: "p1",
        tabId: "tab-1",
        engine: "postgres",
      })
    );

    await waitFor(() => expect(collectMock).toHaveBeenCalled());
    await act(async () => {
      void result.current.refresh();
    });
    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
    await waitFor(() =>
      expect(collectMock.mock.calls.length).toBeGreaterThan(1)
    );
  });

  it("clears and reloads on runtime replacement under the same profile", async () => {
    const { result, rerender } = renderHook(
      (props: any) => useDbHealthInspector(props),
      {
        initialProps: {
          open: true,
          runtimeConnectionId: "c1",
          profileId: "p1",
          tabId: "tab-1",
          engine: "postgres" as const,
        },
      }
    );

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    collectMock.mockResolvedValue(snap({ runtimeConnectionId: "c2" }));
    seedTabRuntime({ tabId: "tab-1", runtimeId: "c2" });
    rerender({
      open: true,
      runtimeConnectionId: "c2",
      profileId: "p1",
      tabId: "tab-1",
      engine: "postgres",
    });

    await waitFor(() =>
      expect(result.current.snapshot?.runtimeConnectionId).toBe("c2")
    );
  });

  it("collects nothing through a connection the tab may not use (D3)", async () => {
    seedTabRuntime({ tabId: "tab-1", runtimeId: "c-other" });
    const { result } = renderHook(() => useDbHealthInspector({ ...pgCtx }));
    await waitFor(() =>
      expect(result.current.error).toMatch(/no longer uses this connection/)
    );
    expect(collectMock).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
  });

  it("marks unsupported engines without querying", async () => {
    const { result } = renderHook(() =>
      useDbHealthInspector({
        open: true,
        runtimeConnectionId: "c1",
        profileId: "p1",
        tabId: "tab-1",
        engine: "mysql",
      })
    );
    await waitFor(() => expect(result.current.supported).toBe(false));
    expect(collectMock).not.toHaveBeenCalled();
    expect(result.current.error).toMatch(/PostgreSQL only/i);
  });

  it("cancel aborts the inspector-owned controller", async () => {
    let signal: AbortSignal | undefined;
    collectMock.mockImplementation(async (args: any) => {
      signal = args.signal;
      await new Promise((r) => setTimeout(r, 100));
      return snap({ cancelled: !!args.signal?.aborted });
    });

    const { result } = renderHook(() =>
      useDbHealthInspector({
        open: true,
        runtimeConnectionId: "c1",
        profileId: "p1",
        tabId: "tab-1",
        engine: "postgres",
      })
    );

    await waitFor(() => expect(signal).toBeTruthy());
    act(() => {
      result.current.cancel();
    });
    expect(signal?.aborted).toBe(true);
  });
});

describe("useDbHealthInspector Pro gating", () => {
  it("collects on open with Pro access", async () => {
    const { result } = renderHook(() => useDbHealthInspector(pgCtx));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(collectMock).toHaveBeenCalledTimes(1);
    expect(result.current.locked).toBe(false);
  });

  it("runs no inspector query without Pro access, even on refresh", async () => {
    setProAccess(false);
    const { result } = renderHook(() => useDbHealthInspector(pgCtx));
    expect(result.current.locked).toBe(true);
    await act(async () => {
      await result.current.refresh();
    });
    expect(collectMock).not.toHaveBeenCalled();
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("stops collecting after a downgrade: refresh issues no query", async () => {
    const { result } = renderHook(() => useDbHealthInspector(pgCtx));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(collectMock).toHaveBeenCalledTimes(1);

    act(() => setProAccess(false));
    await waitFor(() => expect(result.current.locked).toBe(true));
    expect(result.current.snapshot).toBeNull();

    await act(async () => {
      await result.current.refresh();
    });
    expect(collectMock).toHaveBeenCalledTimes(1);
  });

  it("drops a pending result that arrives after a downgrade", async () => {
    let resolveCollect: ((value: unknown) => void) | undefined;
    let signal: AbortSignal | undefined;
    collectMock.mockImplementation((args: any) => {
      signal = args.signal;
      return new Promise((resolve) => {
        resolveCollect = resolve;
      });
    });

    const { result } = renderHook(() => useDbHealthInspector(pgCtx));
    await waitFor(() => expect(resolveCollect).toBeTruthy());
    expect(result.current.loading).toBe(true);

    act(() => setProAccess(false));
    expect(signal?.aborted).toBe(true);

    await act(async () => {
      resolveCollect?.(snap());
    });
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(collectMock).toHaveBeenCalledTimes(1);
  });

  it("collects once Pro access returns while open", async () => {
    setProAccess(false);
    const { result } = renderHook(() => useDbHealthInspector(pgCtx));
    expect(collectMock).not.toHaveBeenCalled();
    act(() => setProAccess(true));
    await waitFor(() => expect(result.current.snapshot).not.toBeNull());
    expect(collectMock).toHaveBeenCalledTimes(1);
  });

  describe("useDbHealthInspector auto-refresh", () => {
    it("refreshes in the background and swaps only a complete snapshot", async () => {
      vi.useFakeTimers();
      try {
        let call = 0;
        let resolveSecond: (value: unknown) => void = () => {};
        collectMock.mockImplementation((args: any) => {
          call += 1;
          if (call === 1) return Promise.resolve(snap({ finishedAt: 10 }));
          expect(args.onProgress).toBeUndefined();
          return new Promise((resolve) => {
            resolveSecond = resolve;
          });
        });
        const { result } = renderHook(() =>
          useDbHealthInspector({ ...pgCtx, autoRefreshMs: 5_000 })
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.snapshot?.finishedAt).toBe(10);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(collectMock).toHaveBeenCalledTimes(2);
        // The previous snapshot stays while the background refresh runs.
        expect(result.current.loading).toBe(false);
        expect(result.current.refreshing).toBe(true);
        expect(result.current.snapshot?.finishedAt).toBe(10);

        await act(async () => {
          resolveSecond(snap({ finishedAt: 20 }));
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.refreshing).toBe(false);
        expect(result.current.snapshot?.finishedAt).toBe(20);
      } finally {
        vi.useRealTimers();
      }
    });

    it("clears an earlier error once a background refresh succeeds", async () => {
      vi.useFakeTimers();
      try {
        const failed = snap({
          finishedAt: 10,
          overallError: "Collection failed",
          overview: { ...snap().overview, status: "error", data: null },
          sessions: { ...snap().sessions, status: "error" },
        });
        collectMock
          .mockResolvedValueOnce(failed)
          .mockResolvedValueOnce(snap({ finishedAt: 20 }));
        const { result } = renderHook(() =>
          useDbHealthInspector({ ...pgCtx, autoRefreshMs: 5_000 })
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(result.current.error).toBe("Collection failed");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(result.current.snapshot?.finishedAt).toBe(20);
        expect(result.current.error).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps the shown snapshot when a background refresh is cancelled", async () => {
      vi.useFakeTimers();
      try {
        collectMock
          .mockResolvedValueOnce(snap({ finishedAt: 10 }))
          .mockResolvedValueOnce(snap({ finishedAt: 20, cancelled: true }));
        const { result } = renderHook(() =>
          useDbHealthInspector({ ...pgCtx, autoRefreshMs: 5_000 })
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(collectMock).toHaveBeenCalledTimes(2);
        expect(result.current.snapshot?.finishedAt).toBe(10);
        expect(result.current.refreshing).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("pauses after a cancelled snapshot until the next manual refresh", async () => {
      vi.useFakeTimers();
      try {
        collectMock.mockResolvedValue(snap({ cancelled: true }));
        renderHook(() =>
          useDbHealthInspector({ ...pgCtx, autoRefreshMs: 5_000 })
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(collectMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not refresh while off or while the window is hidden", async () => {
      vi.useFakeTimers();
      const hidden = vi.spyOn(document, "hidden", "get");
      try {
        const { rerender } = renderHook(
          (props: any) => useDbHealthInspector(props),
          { initialProps: { ...pgCtx, autoRefreshMs: null as number | null } }
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(60_000);
        });
        expect(collectMock).toHaveBeenCalledTimes(1);

        hidden.mockReturnValue(true);
        rerender({ ...pgCtx, autoRefreshMs: 5_000 });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(15_000);
        });
        expect(collectMock).toHaveBeenCalledTimes(1);

        hidden.mockReturnValue(false);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        expect(collectMock).toHaveBeenCalledTimes(2);
      } finally {
        hidden.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  describe("useDbHealthInspector session actions", () => {
    const request = {
      pid: 4242,
      backendToken: "2026-10-22T03:04:05.123456Z",
      kind: "terminate" as const,
    };

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => (resolve = r));
      return { promise, resolve };
    }

    beforeEach(() => {
      signalMock.mockReset();
      signalMock.mockResolvedValue("signalled");
      trackMock.mockReset();
    });

    async function opened() {
      const hook = renderHook((props: any) => useDbHealthInspector(props), {
        initialProps: { ...pgCtx },
      });
      await waitFor(() => expect(hook.result.current.snapshot).not.toBeNull());
      collectMock.mockClear();
      return hook;
    }

    it("asks nothing and sends nothing through a connection the tab may not use (D3)", async () => {
      const { result } = await opened();
      seedTabRuntime({ tabId: "tab-1", runtimeId: "c2" });
      const confirm = vi.fn(async () => true);
      await act(async () => {
        await result.current.runSessionAction(request, confirm);
      });
      expect(confirm).not.toHaveBeenCalled();
      expect(signalMock).not.toHaveBeenCalled();
      expect(result.current.sessionActionResult).toMatchObject({
        outcome: "refused",
      });
    });

    it("sends nothing when the tab's target changes during the confirmation (D3)", async () => {
      const { result } = await opened();
      await act(async () => {
        await result.current.runSessionAction(request, async () => {
          useScreenStore
            .getState()
            .updateTab("tab-1", { target: { kind: "unknown" } });
          return true;
        });
      });
      expect(signalMock).not.toHaveBeenCalled();
      expect(result.current.sessionActionResult).toMatchObject({
        outcome: "refused",
      });
      expect(result.current.sessionAction).toBeNull();
    });

    it("confirms, sends once, reports, then refreshes", async () => {
      const { result } = await opened();
      await act(async () => {
        await result.current.runSessionAction(request, async () => true);
      });
      expect(signalMock).toHaveBeenCalledTimes(1);
      expect(signalMock).toHaveBeenCalledWith({
        runtimeConnectionId: "c1",
        ...request,
      });
      expect(trackMock).toHaveBeenCalledWith("terminate", "signalled");
      expect(result.current.sessionActionResult).toMatchObject({
        pid: 4242,
        outcome: "signalled",
      });
      expect(collectMock).toHaveBeenCalledTimes(1);
      expect(result.current.sessionAction).toBeNull();
    });

    it("does nothing when the confirmation is dismissed or fails", async () => {
      const { result } = await opened();
      await act(async () => {
        await result.current.runSessionAction(request, async () => false);
      });
      await act(async () => {
        await result.current.runSessionAction(request, async () => {
          throw new Error("dialog error");
        });
      });
      expect(signalMock).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalled();
      expect(collectMock).not.toHaveBeenCalled();
      expect(result.current.sessionAction).toBeNull();
    });

    it("runs one action at a time and ignores manual refresh meanwhile", async () => {
      const { result } = await opened();
      const confirm = deferred<boolean>();
      let first!: Promise<void>;
      act(() => {
        first = result.current.runSessionAction(request, () => confirm.promise);
      });
      expect(result.current.sessionAction?.phase).toBe("confirming");
      await act(async () => {
        await result.current.runSessionAction(
          { ...request, pid: 7 },
          async () => true
        );
        await result.current.refresh();
      });
      expect(collectMock).not.toHaveBeenCalled();
      await act(async () => {
        confirm.resolve(true);
        await first;
      });
      expect(signalMock).toHaveBeenCalledTimes(1);
      expect(signalMock.mock.calls[0]![0].pid).toBe(4242);
    });

    it("re-checks Pro access after confirming", async () => {
      const { result } = await opened();
      await act(async () => {
        await result.current.runSessionAction(request, async () => {
          setProAccess(false);
          return true;
        });
      });
      expect(signalMock).not.toHaveBeenCalled();
    });

    it("drops a confirmation that outlived a context change", async () => {
      const { result, rerender } = await opened();
      const confirm = deferred<boolean>();
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.runSessionAction(
          request,
          () => confirm.promise
        );
      });
      rerender({ ...pgCtx, runtimeConnectionId: "c2" });
      await act(async () => {
        confirm.resolve(true);
        await pending;
      });
      expect(signalMock).not.toHaveBeenCalled();
    });

    it("invalidates collection that started before the action", async () => {
      const { result } = await opened();
      const slow = deferred<any>();
      collectMock.mockImplementationOnce(() => slow.promise);
      act(() => {
        void result.current.refresh();
      });
      const staleSignal: AbortSignal = collectMock.mock.calls[0]![0].signal;
      collectMock.mockResolvedValue(snap({ finishedAt: 99 }));
      await act(async () => {
        await result.current.runSessionAction(request, async () => true);
      });
      expect(staleSignal.aborted).toBe(true);
      await act(async () => {
        slow.resolve(snap({ finishedAt: 1 }));
      });
      expect(result.current.snapshot?.finishedAt).toBe(99);
    });

    it("reports the attempt once but writes nothing after the dialog closed", async () => {
      const { result, rerender } = await opened();
      const sent = deferred<string>();
      signalMock.mockImplementationOnce(() => sent.promise);
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.runSessionAction(request, async () => true);
      });
      await waitFor(() => expect(signalMock).toHaveBeenCalled());
      rerender({ ...pgCtx, open: false });
      rerender({ ...pgCtx, open: true });
      collectMock.mockClear();
      await act(async () => {
        sent.resolve("signalled");
        await pending;
      });
      expect(trackMock).toHaveBeenCalledTimes(1);
      expect(result.current.sessionActionResult).toBeNull();
      expect(result.current.sessionAction).toBeNull();
    });

    it("blocks a row after an unknown outcome until a ready Sessions section", async () => {
      const { result } = await opened();
      signalMock.mockResolvedValueOnce("unknown");
      // The reconciliation refresh fails to read Sessions.
      collectMock.mockResolvedValueOnce(
        snap({ sessions: { ...snap().sessions, status: "error", data: [] } })
      );
      await act(async () => {
        await result.current.runSessionAction(request, async () => true);
      });
      expect(
        result.current.isSessionActionBlocked(4242, request.backendToken)
      ).toBe(true);
      expect(result.current.sessionAction).toBeNull();

      // Blocked: no second attempt on that row.
      await act(async () => {
        await result.current.runSessionAction(request, async () => true);
      });
      expect(signalMock).toHaveBeenCalledTimes(1);

      // A newer snapshot with a ready Sessions section unblocks it.
      collectMock.mockResolvedValueOnce(
        snap({ sessions: { ...snap().sessions, status: "ready", data: [] } })
      );
      await act(async () => {
        await result.current.refresh();
      });
      expect(
        result.current.isSessionActionBlocked(4242, request.backendToken)
      ).toBe(false);
    });

    it("releases the lock when the reconciliation refresh fails", async () => {
      const { result } = await opened();
      collectMock.mockRejectedValueOnce(new Error("collect failed"));
      await act(async () => {
        // Never rejects: the outcome stays and the lock is released.
        await result.current.runSessionAction(request, async () => true);
      });
      expect(result.current.sessionAction).toBeNull();
      expect(result.current.sessionActionResult?.outcome).toBe("signalled");
      // Manual Refresh is usable again (not stuck showing Cancel).
      expect(result.current.loading).toBe(false);
      collectMock.mockResolvedValue(snap());
      await act(async () => {
        await result.current.refresh();
      });
      expect(collectMock).toHaveBeenCalledTimes(2);
    });

    it("never dispatches after the Inspector unmounts during confirmation", async () => {
      const { result, unmount } = await opened();
      const confirm = deferred<boolean>();
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.runSessionAction(
          request,
          () => confirm.promise
        );
      });
      unmount();
      await act(async () => {
        confirm.resolve(true);
        await pending;
      });
      expect(signalMock).not.toHaveBeenCalled();
      expect(trackMock).not.toHaveBeenCalled();
    });

    it("reports but does not reconcile when unmounted during dispatch", async () => {
      const { result, unmount } = await opened();
      const sent = deferred<string>();
      signalMock.mockImplementationOnce(() => sent.promise);
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.runSessionAction(request, async () => true);
      });
      await waitFor(() => expect(signalMock).toHaveBeenCalledTimes(1));
      unmount();
      await act(async () => {
        sent.resolve("signalled");
        await pending;
      });
      expect(trackMock).toHaveBeenCalledTimes(1);
      expect(collectMock).not.toHaveBeenCalled();
    });

    it("keeps a newer attempt's lock when an older one completes late", async () => {
      const { result, rerender } = await opened();
      const oldSent = deferred<string>();
      signalMock.mockImplementationOnce(() => oldSent.promise);
      let oldAttempt!: Promise<void>;
      act(() => {
        oldAttempt = result.current.runSessionAction(request, async () => true);
      });
      await waitFor(() => expect(signalMock).toHaveBeenCalledTimes(1));
      rerender({ ...pgCtx, open: false });
      rerender({ ...pgCtx, open: true });
      await waitFor(() => expect(result.current.snapshot).not.toBeNull());

      const newConfirm = deferred<boolean>();
      let newAttempt!: Promise<void>;
      act(() => {
        newAttempt = result.current.runSessionAction(
          { ...request, pid: 7 },
          () => newConfirm.promise
        );
      });
      expect(result.current.sessionAction?.pid).toBe(7);
      await act(async () => {
        oldSent.resolve("signalled");
        await oldAttempt;
      });
      // The old completion neither released nor replaced the newer attempt.
      expect(result.current.sessionAction).toMatchObject({
        pid: 7,
        phase: "confirming",
      });
      expect(result.current.sessionActionResult).toBeNull();
      await act(async () => {
        newConfirm.resolve(false);
        await newAttempt;
      });
      expect(result.current.sessionAction).toBeNull();
    });

    it("pauses auto-refresh while an action is pending", async () => {
      vi.useFakeTimers();
      try {
        const { result } = renderHook(() =>
          useDbHealthInspector({ ...pgCtx, autoRefreshMs: 5_000 })
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        const confirm = deferred<boolean>();
        act(() => {
          void result.current.runSessionAction(request, () => confirm.promise);
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        expect(collectMock).toHaveBeenCalledTimes(1);
        await act(async () => {
          confirm.resolve(false);
          await vi.advanceTimersByTimeAsync(0);
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
