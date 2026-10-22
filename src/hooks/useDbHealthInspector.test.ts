import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/preact";
import { useDbHealthInspector } from "./useDbHealthInspector";
import { useLicenseStore } from "src/stores/license";
import type { LicenseState } from "src/lib/tauri/license";

const collectMock = vi.fn();

vi.mock("src/lib/tauri/health-inspector", () => ({
  collectHealthInspectorSnapshot: (...args: any[]) => collectMock(...args),
}));

function snap(partial?: Record<string, unknown>) {
  return {
    runtimeConnectionId: "c1",
    profileId: "p1",
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
  engine: "postgres" as const,
};

beforeEach(() => {
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
          engine: "postgres" as const,
        },
      }
    );

    await waitFor(() => expect(result.current.snapshot).not.toBeNull());

    collectMock.mockResolvedValue(snap({ runtimeConnectionId: "c2" }));
    rerender({
      open: true,
      runtimeConnectionId: "c2",
      profileId: "p1",
      engine: "postgres",
    });

    await waitFor(() =>
      expect(result.current.snapshot?.runtimeConnectionId).toBe("c2")
    );
  });

  it("marks unsupported engines without querying", async () => {
    const { result } = renderHook(() =>
      useDbHealthInspector({
        open: true,
        runtimeConnectionId: "c1",
        profileId: "p1",
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
});
