import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  connect: vi.fn(),
  remove: vi.fn(async () => {}),
  dirty: vi.fn((_tabId: string) => false),
}));

vi.mock("src/lib/tauri/profile", () => ({ profileConnect: m.connect }));
vi.mock("src/lib/tauri/connection", () => ({ connectionRemove: m.remove }));
vi.mock("src/lib/tauri/operation", () => ({
  operationCancel: vi.fn(async () => {}),
}));
vi.mock("src/screens/connection/lib/tabDirty", () => ({
  connectionTabHasChanges: m.dirty,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import {
  connectTabOnce,
  releaseRuntime,
  resolveTabRuntimeConnectionId,
  TAB_CONNECT_SUPERSEDED,
  TAB_HAS_UNSAVED_CHANGES,
  TAB_TARGET_UNKNOWN,
} from "./runtimeConnection";
import { noteRuntimeError } from "src/lib/tauri/runtimeAdmission";
import { useProfileStore } from "src/stores/profile";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";
import { useScreenStore } from "src/stores/screen";
import { useConnectionStore } from "src/stores/connection";

let next = 0;
function answer(override: string | null, profile = "p1") {
  const id = `rt${++next}`;
  return {
    profile: { id: profile },
    connection: {
      id,
      engine: "postgres",
      label: "x",
      target: {
        profile_id: profile,
        profile_revision: "r1",
        database_override: override,
        engine: "postgres",
        display: override ?? "app",
      },
    },
  };
}

function tab(id: string, target: unknown, extra: object = {}) {
  return {
    id,
    profileId: "p1",
    engine: "postgres",
    label: id,
    target,
    ...extra,
  };
}

function setTabs(tabs: unknown[]) {
  useScreenStore.setState({ profileTabs: tabs as never, tabEpoch: {} });
}

const tabOf = (id: string) =>
  useScreenStore.getState().profileTabs.find((t) => t.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  m.dirty.mockReturnValue(false);
  m.connect.mockImplementation(
    async (_p: string, opts?: { database?: string }) =>
      answer(opts?.database ?? null)
  );
  useRuntimeTargetsStore.setState({ targets: {}, owners: {}, refused: {} });
  useConnectionStore.setState({ tableDataMap: {} } as never);
  useProfileStore.setState({
    profiles: [
      {
        id: "p1",
        label: "Athena",
        engine: "postgres",
        input: { engine: "postgres", postgres: { database: "app" } },
      },
    ] as never,
  });
});

describe("connecting a tab (R1, R3)", () => {
  it("opens what the tab was opened on, never the profile's own by default", async () => {
    setTabs([
      tab("home", { kind: "default" }),
      tab("b", { kind: "override", database: "b" }),
    ]);
    const home = await connectTabOnce("home");
    const b = await connectTabOnce("b");
    expect(m.connect).toHaveBeenNthCalledWith(1, "p1", undefined);
    expect(m.connect).toHaveBeenNthCalledWith(2, "p1", { database: "b" });
    expect(tabOf("home")?.runtimeConnectionId).toBe(home);
    expect(tabOf("b")?.runtimeConnectionId).toBe(b);
    // Each tab owns its own.
    expect(useRuntimeTargetsStore.getState().owners).toMatchObject({
      [home]: "home",
      [b]: "b",
    });
  });

  it("gives two tabs on the same database two connections", async () => {
    setTabs([
      tab("b1", { kind: "override", database: "b" }),
      tab("b2", { kind: "override", database: "b" }),
    ]);
    const [one, two] = await Promise.all([
      connectTabOnce("b1"),
      connectTabOnce("b2"),
    ]);
    expect(one).not.toBe(two);
    expect(m.connect).toHaveBeenCalledTimes(2);
  });

  it("never connects a tab whose target is unknown", async () => {
    setTabs([tab("legacy", { kind: "unknown" }, { label: "Athena · b" })]);
    await expect(connectTabOnce("legacy")).rejects.toThrow(TAB_TARGET_UNKNOWN);
    expect(m.connect).not.toHaveBeenCalled();
  });

  it("removes a connection that finished after its tab closed", async () => {
    setTabs([tab("b", { kind: "override", database: "b" })]);
    let resolve!: (v: unknown) => void;
    m.connect.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const pending = connectTabOnce("b");
    setTabs([]);
    const late = answer("b");
    resolve(late);
    await expect(pending).rejects.toThrow(TAB_CONNECT_SUPERSEDED);
    expect(m.remove).toHaveBeenCalledWith(late.connection.id);
  });

  it("removes a connection that finished after the tab changed target", async () => {
    setTabs([tab("t", { kind: "override", database: "b" })]);
    let resolve!: (v: unknown) => void;
    m.connect.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const pending = connectTabOnce("t");
    setTabs([tab("t", { kind: "override", database: "c" })]);
    const late = answer("b");
    resolve(late);
    await expect(pending).rejects.toThrow(TAB_CONNECT_SUPERSEDED);
    expect(m.remove).toHaveBeenCalledWith(late.connection.id);
    expect(tabOf("t")?.runtimeConnectionId).toBeUndefined();
  });

  it("never replaces the connection of a tab with unsaved changes (R21)", async () => {
    setTabs([tab("t", { kind: "default" })]);
    const first = await connectTabOnce("t");
    m.dirty.mockReturnValue(true);
    await expect(connectTabOnce("t", { force: true })).rejects.toThrow(
      TAB_HAS_UNSAVED_CHANGES
    );
    expect(tabOf("t")?.runtimeConnectionId).toBe(first);
    expect(m.remove).not.toHaveBeenCalled();
  });

  it("replaces and removes its own previous connection on a forced reconnect", async () => {
    setTabs([tab("t", { kind: "default" })]);
    const first = await connectTabOnce("t");
    const second = await connectTabOnce("t", { force: true });
    expect(second).not.toBe(first);
    expect(tabOf("t")?.runtimeConnectionId).toBe(second);
    expect(m.remove).toHaveBeenCalledWith(first);
  });
});

describe("ownership (R4)", () => {
  it("never removes or adopts another tab's connection", async () => {
    setTabs([tab("a", { kind: "default" }), tab("b", { kind: "default" })]);
    const b = await connectTabOnce("b");
    // Tab A's table entry refers to B's live connection.
    useConnectionStore.setState({
      tableDataMap: { "a.public.t": { connectionId: b } },
    } as never);
    expect(
      resolveTabRuntimeConnectionId({
        activeProfileScreen: "a",
        tableDataMap: useConnectionStore.getState().tableDataMap,
      })
    ).toBeUndefined();
    await releaseRuntime(b, "a");
    expect(m.remove).not.toHaveBeenCalled();
    await releaseRuntime(b, "b");
    expect(m.remove).toHaveBeenCalledWith(b);
  });
});

describe("a refused (stale) connection (R20)", () => {
  it("invalidates only the tab that still uses that very connection", async () => {
    setTabs([tab("t", { kind: "default" })]);
    const first = await connectTabOnce("t");
    const second = await connectTabOnce("t", { force: true });
    const epoch = () => useScreenStore.getState().tabEpoch["t"] ?? 0;
    const before = epoch();
    // A late refusal of the replaced connection changes nothing.
    noteRuntimeError(first, new Error("RUNTIME_STALE"));
    expect(epoch()).toBe(before);
    noteRuntimeError(second, "RUNTIME_STALE");
    expect(epoch()).toBe(before + 1);
    expect(useRuntimeTargetsStore.getState().refused[second]).toBe(
      "RUNTIME_STALE"
    );
  });
});

describe("installing a connection (R4/R5)", () => {
  const tableState = (connectionId: string) => ({
    "t.public.items": { connectionId, loaded: true, columns: [{ name: "a" }] },
  });

  it("drops table data loaded through a foreign connection instead of relabelling it", async () => {
    setTabs([tab("t", { kind: "default" })]);
    useConnectionStore.setState({
      tableDataMap: tableState("foreign"),
      columnsCache: { "t.public.items": [{ name: "a" }] },
    } as never);
    const id = await connectTabOnce("t");
    expect(
      useConnectionStore.getState().tableDataMap["t.public.items"]
    ).toBeUndefined();
    expect(
      useConnectionStore.getState().columnsCache["t.public.items"]
    ).toBeUndefined();
    expect(tabOf("t")?.runtimeConnectionId).toBe(id);
  });

  it("drops caches, filters and sort of the old connection on replacement", async () => {
    setTabs([tab("t", { kind: "default" })]);
    const first = await connectTabOnce("t");
    useConnectionStore.setState({
      tableDataMap: tableState(first),
      columnsCache: { "t.public.items": [{ name: "a" }] },
      sizeInfoCache: { "t.public.items": { totalSize: "1" } },
      tableFilterByKey: {
        "t.public.items": { filters: [], filterCombine: "AND" },
      },
      tableSortByKey: { "t.public.items": { column: "a", direction: "asc" } },
      tableStructure: { t: { w: [] } },
    } as never);
    await connectTabOnce("t", { force: true });
    const s = useConnectionStore.getState();
    expect(s.tableDataMap["t.public.items"]).toBeUndefined();
    expect(s.columnsCache["t.public.items"]).toBeUndefined();
    expect(s.sizeInfoCache["t.public.items"]).toBeUndefined();
    expect(s.tableFilterByKey["t.public.items"]).toBeUndefined();
    expect(s.tableSortByKey["t.public.items"]).toBeUndefined();
    expect(s.tableStructure.t).toBeUndefined();
  });
});

describe("streams of a tab whose epoch moved (R5)", () => {
  it("are stopped, so nothing stays pending", async () => {
    setTabs([tab("t", { kind: "default" })]);
    useConnectionStore.setState({
      tableRowsByKey: {
        "t.public.items": { opId: "op-1", running: true, rows: [] },
        "other.public.items": { opId: "op-2", running: true, rows: [] },
      },
    } as never);
    useScreenStore.getState().bumpTabEpochs(["t"]);
    const rows = useConnectionStore.getState().tableRowsByKey;
    expect(rows["t.public.items"]?.running).toBe(false);
    expect(rows["other.public.items"]?.running).toBe(true);
  });
});
