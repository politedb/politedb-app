import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import { editDraftKey, windowIdForDraftKey } from "src/lib/objectDraftKey";
import { useObjectDraftStore } from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import { useToastStore } from "src/stores/toast";
import type { DatabaseObjectItem, OpenWindow } from "src/types";
import { metaKeyForTab, openCreatedObject } from "./objectWindows";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const item = (name: string, signature = "", schema = "public") =>
  buildDatabaseObjectItem({
    engine: "postgres",
    kind: "function",
    schema,
    name,
    signature,
  });
const target = item("calc");
const tab = { id: "t1", engine: "postgres", runtimeConnectionId: "c1" };

function refreshWith(objects: DatabaseObjectItem[], during?: () => void) {
  return vi.fn(async () => {
    during?.();
    return {
      ok: true as const,
      metaKey: metaKeyForTab(tab),
      connectionId: "c1",
      objects,
    };
  });
}

function open(refresh: ReturnType<typeof refreshWith>) {
  return openCreatedObject({
    screenTabId: "t1",
    connectionId: "c1",
    kind: "function",
    schema: "public",
    name: "calc",
    refresh,
  });
}

const windows = () => useScreenStore.getState().openWindows.t1 ?? [];
const hint = () =>
  useToastStore
    .getState()
    .toasts.some((t) => t.message.includes("Objects sidebar"));

beforeEach(() => {
  useObjectDraftStore.getState().clearAll();
  useToastStore.setState({ toasts: [] });
  useScreenStore.setState({
    activeProfileScreen: "main",
    profileTabs: [tab as never, { id: "t2", engine: "postgres" } as never],
    openWindows: { t1: [], t2: [] },
    activeWindowId: { t1: null, t2: null },
    tabEpoch: {},
  });
});

describe("openCreatedObject", () => {
  it("opens exactly one match and shows its screen tab", async () => {
    await open(refreshWith([target, item("other")]));
    expect(windows().map((w) => w.id)).toEqual([
      windowIdForDraftKey(editDraftKey(target.id)),
    ]);
    expect(useScreenStore.getState().activeProfileScreen).toBe("t1");
    expect(hint()).toBe(false);
  });

  it("points to the sidebar for no or several matches", async () => {
    await open(refreshWith([]));
    expect(windows()).toEqual([]);
    expect(hint()).toBe(true);

    useToastStore.setState({ toasts: [] });
    await open(refreshWith([item("calc", "a int"), item("calc", "b text")]));
    expect(windows()).toEqual([]);
    expect(hint()).toBe(true);
  });

  it("focuses an open window without touching its draft", async () => {
    const key = editDraftKey(target.id);
    const store = useObjectDraftStore.getState();
    store.ensureEditDraft("t1", key, target);
    store.applyDefinition(
      "t1",
      key,
      useObjectDraftStore.getState().drafts.t1![key]!.generation,
      "v1",
      target
    );
    store.setSql("t1", key, "mine");
    const win = {
      id: windowIdForDraftKey(key),
      type: "db-object-manager",
      title: "calc",
      initialKind: "function",
      initialObjectId: target.id,
    } as OpenWindow;
    useScreenStore.setState({ openWindows: { t1: [win] } });
    await open(refreshWith([target]));
    expect(windows()).toHaveLength(1);
    expect(useObjectDraftStore.getState().drafts.t1![key]!.sql).toBe("mine");
  });

  it("does nothing when the tab is closed, reset or reconnected meanwhile", async () => {
    await open(
      refreshWith([target], () =>
        useScreenStore.getState().updateTab("t1", { runtimeConnectionId: "c2" })
      )
    );
    expect(windows()).toEqual([]);
    expect(hint()).toBe(true);

    // A reset during the refresh: same id, same connection, new lifetime.
    useToastStore.setState({ toasts: [] });
    useScreenStore.setState({ profileTabs: [tab as never] });
    const resetting = refreshWith([target], () =>
      useScreenStore.getState().resetTabs([tab as never])
    );
    await open(resetting);
    expect(resetting).toHaveBeenCalled();
    expect(windows()).toEqual([]);
    expect(hint()).toBe(true);

    useScreenStore.setState({ profileTabs: [] });
    const refresh = refreshWith([target]);
    await open(refresh);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("does nothing when the refresh rejects or fails", async () => {
    await open(vi.fn(async () => Promise.reject(new Error("x"))) as never);
    expect(hint()).toBe(true);
    useToastStore.setState({ toasts: [] });
    await open(
      vi.fn(async () => ({
        ok: false as const,
        metaKey: metaKeyForTab(tab),
        connectionId: "c1",
        error: "x",
      })) as never
    );
    expect(windows()).toEqual([]);
    expect(hint()).toBe(true);
  });

  it("never retargets another screen tab", async () => {
    useScreenStore.setState({ activeProfileScreen: "t2" });
    await open(refreshWith([target]));
    expect(useScreenStore.getState().openWindows.t2).toEqual([]);
    expect(windows()).toHaveLength(1);
  });
});
