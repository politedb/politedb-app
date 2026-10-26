import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import { windowIdForDraftKey } from "src/lib/objectDraftKey";
import { hasPendingWork, useObjectDraftStore } from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import { useToastStore } from "src/stores/toast";
import type { OpenWindow } from "src/types";
import {
  discardObjectDraftsForTab,
  isObjectSaveRunning,
  saveObjectDraftsForTab,
} from "./objectSave";
import type { ObjectMetadataRefresh } from "./objectWindows";

const mocks = vi.hoisted(() => ({
  runSqlQuery: vi.fn(),
  executeTransaction: vi.fn(),
}));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: mocks.runSqlQuery }));
vi.mock("src/lib/tauri", () => ({
  operationExecuteTransaction: mocks.executeTransaction,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const TAB = "t1";
const NEW = "new:function:a";
const fn = buildDatabaseObjectItem({
  engine: "postgres",
  kind: "function",
  schema: "public",
  name: "calc",
  signature: "",
});
const EDIT = `obj:${fn.id}`;
const drafts = () => useObjectDraftStore.getState();
const draft = (key: string) => drafts().drafts[TAB]?.[key];

function seedCreate() {
  drafts().ensureCreateDraft(TAB, NEW, {
    kind: "function",
    form: { schema: "public", name: "new_function", tableName: "" },
    sql: "CREATE FUNCTION public.new_function() RETURNS int AS $$ SELECT 1 $$ LANGUAGE sql",
  });
}

function seedDirtyEdit(sql = "CREATE OR REPLACE FUNCTION calc() v2") {
  drafts().ensureEditDraft(TAB, EDIT, fn);
  drafts().applyDefinition(TAB, EDIT, draft(EDIT)!.generation, "v1", fn);
  drafts().setSql(TAB, EDIT, sql);
}

function objectWindow(key: string): OpenWindow {
  return {
    id: windowIdForDraftKey(key),
    type: "db-object-manager",
    title: key,
    initialKind: "function",
    initialObjectId: key.startsWith("obj:") ? fn.id : "",
  } as OpenWindow;
}

function save(
  refresh: ObjectMetadataRefresh = vi.fn(async () => ({
    ok: true as const,
    metaKey: "m",
    connectionId: "c1",
    objects: [fn],
  }))
) {
  return saveObjectDraftsForTab({
    tabId: TAB,
    engine: "postgres",
    resolveConnectionId: async () => "c1",
    refreshObjectMetadata: refresh,
    refreshFallback: vi.fn(),
    setError: vi.fn(),
  });
}

beforeEach(() => {
  mocks.runSqlQuery.mockReset().mockResolvedValue({});
  mocks.executeTransaction.mockReset().mockResolvedValue({});
  drafts().clearAll();
  useToastStore.setState({ toasts: [] });
  useScreenStore.setState({
    openWindows: { [TAB]: [] },
    activeWindowId: { [TAB]: null },
    profileTabs: [],
    tabEpoch: {},
  });
});

describe("saveObjectDraftsForTab", () => {
  it("runs a closed create once, consumes it and offers Open", async () => {
    seedCreate();
    await save();
    expect(mocks.runSqlQuery).toHaveBeenCalledTimes(1);
    expect(draft(NEW)).toBeUndefined();
    const toast = useToastStore.getState().toasts[0]!;
    expect(toast.message).toBe('Created function "new_function".');
    expect(toast.action?.label).toBe("Open");

    // A second save has nothing to replay.
    await save();
    expect(mocks.runSqlQuery).toHaveBeenCalledTimes(1);
  });

  it("closes the saved create's window and focuses its neighbor", async () => {
    seedCreate();
    const other = { id: "sql-1", type: "sql", title: "q" } as OpenWindow;
    useScreenStore.setState({
      openWindows: { [TAB]: [objectWindow(NEW), other] },
      activeWindowId: { [TAB]: windowIdForDraftKey(NEW) },
    });
    await save();
    const s = useScreenStore.getState();
    expect(s.openWindows[TAB]!.map((w) => w.id)).toEqual(["sql-1"]);
    expect(s.activeWindowId[TAB]).toBe("sql-1");
  });

  it("runs creates and edits in one transaction; edits typed meanwhile stay", async () => {
    seedCreate();
    seedDirtyEdit("submitted");
    mocks.executeTransaction.mockImplementation(async () => {
      drafts().setSql(TAB, EDIT, "typed while saving");
      return {};
    });
    await save();
    expect(mocks.executeTransaction).toHaveBeenCalledTimes(1);
    expect(mocks.executeTransaction.mock.calls[0]![0].statements).toHaveLength(
      2
    );
    expect(draft(EDIT)!.baselineSql).toBe("submitted");
    expect(draft(EDIT)!.sql).toBe("typed while saving");
    expect(hasPendingWork(draft(EDIT)!)).toBe(true);
  });

  it("keeps every draft when the statements fail", async () => {
    seedCreate();
    mocks.runSqlQuery.mockRejectedValue(new Error("syntax error"));
    await expect(save()).rejects.toThrow("syntax error");
    expect(draft(NEW)!.saving).toBe(false);
    expect(draft(NEW)!.sql).toContain("new_function");
    expect(isObjectSaveRunning(TAB)).toBe(false);
  });

  it("makes a create read-only while saving and ignores a second save", async () => {
    seedCreate();
    let finish!: () => void;
    mocks.runSqlQuery.mockReturnValue(
      new Promise((resolve) => (finish = () => resolve({})))
    );
    const first = save();
    await vi.waitFor(() => expect(mocks.runSqlQuery).toHaveBeenCalled());
    expect(draft(NEW)!.saving).toBe(true);
    drafts().setSql(TAB, NEW, "changed");
    expect(draft(NEW)!.sql).toContain("new_function");
    await save();
    expect(mocks.runSqlQuery).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(isObjectSaveRunning(TAB)).toBe(false);
  });

  it("leaves a create re-created or discarded during the save alone", async () => {
    seedCreate();
    mocks.runSqlQuery.mockImplementation(async () => {
      drafts().remove(TAB, NEW);
      seedCreate();
      return {};
    });
    await save();
    expect(draft(NEW)).toBeTruthy();
    expect(draft(NEW)!.saving).toBe(false);
  });

  it("does not bless an edit discarded during the save", async () => {
    seedDirtyEdit();
    mocks.runSqlQuery.mockImplementation(async () => {
      drafts().revert(TAB, EDIT);
      return {};
    });
    await save();
    expect(draft(EDIT)!.baselineSql).toBe("v1");
  });

  it("refreshes the tab's metadata after the statements ran", async () => {
    // Missing objects are reconciled by that load (objectReconcile.test).
    seedCreate();
    const refresh = vi.fn(async () => ({
      ok: true as const,
      metaKey: "m",
      connectionId: "c1",
      objects: [],
    }));
    await save(refresh);
    expect(refresh).toHaveBeenCalledWith(TAB);

    seedCreate();
    mocks.runSqlQuery.mockRejectedValueOnce(new Error("x"));
    await expect(save(refresh)).rejects.toThrow();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("locks a create before resolving the connection", async () => {
    seedCreate();
    let resolve!: (id: string) => void;
    const run = saveObjectDraftsForTab({
      tabId: TAB,
      engine: "postgres",
      resolveConnectionId: () => new Promise((r) => (resolve = r)),
      refreshFallback: vi.fn(async () => {}),
      setError: vi.fn(),
    });
    drafts().setSql(TAB, NEW, "edited while resolving");
    expect(draft(NEW)!.sql).toContain("new_function");
    resolve("c1");
    await run;
    expect(mocks.runSqlQuery.mock.calls[0]![1]).toContain("new_function");
  });

  it("releases the lock when no connection resolves", async () => {
    seedCreate();
    const setError = vi.fn();
    await saveObjectDraftsForTab({
      tabId: TAB,
      engine: "postgres",
      resolveConnectionId: async () => null,
      refreshFallback: vi.fn(),
      setError,
    });
    expect(setError).toHaveBeenCalledWith("No active connection.");
    expect(mocks.runSqlQuery).not.toHaveBeenCalled();
    expect(isObjectSaveRunning(TAB)).toBe(false);
    expect(draft(NEW)!.saving).toBe(false);
  });
});

describe("discardObjectDraftsForTab", () => {
  it("drops creates (closing their windows) and reverts edits", () => {
    seedCreate();
    seedDirtyEdit();
    useScreenStore.setState({
      openWindows: { [TAB]: [objectWindow(NEW), objectWindow(EDIT)] },
      activeWindowId: { [TAB]: windowIdForDraftKey(NEW) },
    });
    discardObjectDraftsForTab(TAB);
    expect(draft(NEW)).toBeUndefined();
    expect(draft(EDIT)!.sql).toBe("v1");
    expect(
      useScreenStore.getState().openWindows[TAB]!.map((w) => w.id)
    ).toEqual([windowIdForDraftKey(EDIT)]);
  });
});
