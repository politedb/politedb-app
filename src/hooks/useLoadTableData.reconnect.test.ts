import { act, renderHook, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  execute: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("src/lib/table-data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/table-data")>()),
  executeEngineLoad: m.execute,
}));
vi.mock("src/lib/tauri/profile", () => ({ profileConnect: m.connect }));
vi.mock("src/lib/tauri/connection", () => ({
  connectionRemove: vi.fn(async () => {}),
}));
vi.mock("src/lib/tauri/operation", () => ({
  operationCancel: vi.fn(async () => {}),
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { useConnectionStore } from "src/stores/connection";
import { useProfileStore } from "src/stores/profile";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";
import { useScreenStore } from "src/stores/screen";
import { useLoadTableData } from "./useLoadTableData";

const KEY = "t.public.items";

function setTab(extra: object = {}) {
  useScreenStore.setState({
    activeProfileScreen: "t",
    profileTabs: [
      {
        id: "t",
        profileId: "p1",
        engine: "postgres",
        label: "t",
        target: { kind: "default" },
        ...extra,
      },
    ] as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useRuntimeTargetsStore.setState({ targets: {}, owners: {}, refused: {} });
  useConnectionStore.setState({
    tableDataMap: {},
    columnsCache: {},
    sizeInfoCache: {},
  } as never);
  useProfileStore.setState({
    profiles: [
      {
        id: "p1",
        label: "p",
        engine: "postgres",
        input: { engine: "postgres", postgres: { database: "app" } },
      },
    ] as never,
  });
});

describe("a load after a reconnect (R5)", () => {
  it("never waits for, or joins, a load started on the old connection", async () => {
    setTab({ runtimeConnectionId: "rt-a" });
    let releaseA!: () => void;
    m.execute.mockImplementationOnce(
      () => new Promise<void>((r) => (releaseA = r))
    );
    m.execute.mockResolvedValue(undefined);
    const { result } = renderHook(() => useLoadTableData());

    let a!: Promise<void>;
    act(() => {
      a = result.current.loadTableData("public", "items");
    });
    await act(async () => {});
    expect(m.execute).toHaveBeenCalledTimes(1);
    expect(m.execute.mock.calls[0]![0].connId).toBe("rt-a");

    // The tab moves to another connection while A is still pending.
    act(() =>
      useScreenStore.getState().updateTab("t", { runtimeConnectionId: "rt-b" })
    );
    let b!: Promise<void>;
    act(() => {
      b = result.current.loadTableData("public", "items");
    });
    await act(async () => {
      await b;
    });
    expect(m.execute).toHaveBeenCalledTimes(2);
    expect(m.execute.mock.calls[1]![0].connId).toBe("rt-b");

    // A finishing late clears nothing of B's and publishes nothing.
    await act(async () => {
      releaseA();
      await a;
    });
    expect(m.execute.mock.calls[0]![0].isCurrent()).toBe(false);
    expect(m.execute.mock.calls[1]![0].isCurrent()).toBe(true);
  });
});

describe("a table-first load on a tab without a connection (R4)", () => {
  it("never brings back what another connection loaded", async () => {
    setTab();
    useConnectionStore.setState({
      tableDataMap: {
        [KEY]: {
          connectionId: "foreign",
          loaded: true,
          columns: [{ name: "foreign_column" }],
          constraints: [{ name: "foreign_pk" }],
        },
      },
      columnsCache: { [KEY]: [{ name: "foreign_column" }] },
    } as never);
    m.connect.mockResolvedValue({
      profile: { id: "p1" },
      connection: {
        id: "rt-new",
        engine: "postgres",
        label: "p",
        target: {
          profile_id: "p1",
          profile_revision: "r",
          database_override: null,
          engine: "postgres",
          display: "app",
        },
      },
    });
    m.execute.mockResolvedValue(undefined);
    const { result } = renderHook(() => useLoadTableData());
    await act(async () => {
      await result.current.loadTableData("public", "items");
    });

    expect(m.execute).toHaveBeenCalledTimes(1);
    const ctx = m.execute.mock.calls[0]![0];
    expect(ctx.connId).toBe("rt-new");
    const seen = JSON.stringify([ctx.prev, ctx.columnsCache, ctx.plan]);
    expect(seen).not.toContain("foreign_column");
    expect(seen).not.toContain("foreign_pk");
    // The new target's columns are fetched, not taken as loaded.
    expect(ctx.plan.needColumns).toBe(true);
    const entry = JSON.stringify(
      useConnectionStore.getState().tableDataMap[KEY] ?? {}
    );
    expect(entry).not.toContain("foreign_column");
    expect(entry).not.toContain("foreign_pk");
    expect(entry).not.toContain('"connectionId":"foreign"');
  });
});

/** An executor that marks the table busy, then waits, then clears it. */
function pendingExecutor() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const impl = async (ctx: {
    key: string;
    setMeta: (k: string, d: unknown) => void;
  }) => {
    await gate;
    const cur = useConnectionStore.getState().tableDataMap[ctx.key] ?? {};
    ctx.setMeta(ctx.key, { ...cur, busy: false, rowCount: 1 });
  };
  return { impl, release };
}

const entry = () =>
  useConnectionStore.getState().tableDataMap[KEY] as
    | { busy?: boolean; error?: string | null; connectionId?: string }
    | undefined;

describe("pending state belongs to its own request (R5)", () => {
  for (const [name, invalidate] of [
    [
      "a runtime replacement",
      () =>
        useScreenStore
          .getState()
          .updateTab("t", { runtimeConnectionId: "rt-b" }),
    ],
    ["an epoch move", () => useScreenStore.getState().bumpTabEpochs(["t"])],
  ] as const) {
    it(`an old load settling after ${name} never clears the newer one's busy flag`, async () => {
      setTab({ runtimeConnectionId: "rt-a" });
      const a = pendingExecutor();
      const b = pendingExecutor();
      m.execute.mockImplementationOnce(a.impl).mockImplementationOnce(b.impl);
      const { result } = renderHook(() => useLoadTableData());

      let loadA!: Promise<void>;
      act(() => {
        loadA = result.current.loadTableData("public", "items");
      });
      await act(async () => {});
      act(() => invalidate());
      let loadB!: Promise<void>;
      act(() => {
        loadB = result.current.loadTableData("public", "items");
      });
      await act(async () => {});
      expect(m.execute).toHaveBeenCalledTimes(2);
      expect(entry()?.busy).toBe(true);

      // A settles while B is still pending: B stays busy.
      await act(async () => {
        a.release();
        await loadA;
      });
      expect(entry()?.busy).toBe(true);

      await act(async () => {
        b.release();
        await loadB;
      });
      expect(entry()?.busy).toBe(false);
    });
  }
});

describe("a connect that fails late (R4/R5)", () => {
  it("never reports its error on the table a newer load has loaded", async () => {
    setTab();
    let fail!: (e: Error) => void;
    m.connect.mockReturnValueOnce(new Promise((_, r) => (fail = r)));
    m.execute.mockImplementation(
      async (ctx: {
        key: string;
        setMeta: (k: string, d: unknown) => void;
      }) => {
        const cur = useConnectionStore.getState().tableDataMap[ctx.key] ?? {};
        ctx.setMeta(ctx.key, { ...cur, busy: false, rowCount: 5 });
      }
    );
    const { result } = renderHook(() => useLoadTableData());

    let loadA!: Promise<void>;
    act(() => {
      loadA = result.current.loadTableData("public", "items");
    });
    await act(async () => {});
    // Meanwhile the tab got a connection and the table loaded on it.
    act(() => {
      useRuntimeTargetsStore.getState().register("rt-b", null, "t");
      useScreenStore.getState().updateTab("t", { runtimeConnectionId: "rt-b" });
    });
    await act(async () => {
      await result.current.loadTableData("public", "items", undefined, {
        force: true,
      });
    });
    expect(entry()?.connectionId).toBe("rt-b");

    await act(async () => {
      fail(new Error("RUNTIME_CONNECT_FAILED: boom"));
      await loadA;
    });
    expect(entry()?.error ?? null).toBeNull();
    expect(entry()?.connectionId).toBe("rt-b");
  });

  it("stays silent when superseded by a newer connect", async () => {
    setTab();
    m.connect.mockRejectedValueOnce(new Error("TAB_CONNECT_SUPERSEDED"));
    const { result } = renderHook(() => useLoadTableData());
    await act(async () => {
      await result.current.loadTableData("public", "items");
    });
    expect(entry()?.error ?? null).toBeNull();
  });
});

describe("a table-first load after its acquisition (R5)", () => {
  it("still coalesces identical loads of the new connection", async () => {
    setTab();
    m.connect.mockResolvedValue({
      profile: { id: "p1" },
      connection: {
        id: "rt-new",
        engine: "postgres",
        label: "p",
        target: {
          profile_id: "p1",
          profile_revision: "r",
          database_override: null,
          engine: "postgres",
          display: "app",
        },
      },
    });
    const first = pendingExecutor();
    m.execute.mockImplementation(first.impl);
    const { result } = renderHook(() => useLoadTableData());

    let one!: Promise<void>;
    act(() => {
      one = result.current.loadTableData("public", "items");
    });
    await waitFor(() => expect(m.execute).toHaveBeenCalledTimes(1));
    // An identical ordinary load once the connection is installed joins it.
    let two!: Promise<void>;
    act(() => {
      two = result.current.loadTableData("public", "items");
    });
    await act(async () => {});
    expect(m.execute).toHaveBeenCalledTimes(1);
    // A forced refresh still bypasses it.
    act(() => {
      void result.current.loadTableData("public", "items", undefined, {
        forceRefresh: true,
      });
    });
    await act(async () => {});
    expect(m.execute).toHaveBeenCalledTimes(2);
    await act(async () => {
      first.release();
      await Promise.all([one, two]);
    });
  });
});
