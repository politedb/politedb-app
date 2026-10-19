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
});
