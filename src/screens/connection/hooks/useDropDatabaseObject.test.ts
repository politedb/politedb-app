import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseObjectItem, OpenWindow } from "src/types";

const m = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  runSqlQuery: vi.fn(),
  showToast: vi.fn(),
  refresh: vi.fn(async () => {}),
}));

vi.mock("src/lib/system-dialog", () => ({ confirmDialog: m.confirmDialog }));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: m.runSqlQuery }));
vi.mock("src/stores/toast", () => ({ showToast: m.showToast }));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));
vi.mock("../workspace/ConnectionRuntimeContext", () => ({
  useConnectionRuntimeCtx: () => ({
    engine: "postgres",
    runtimeConnectionId: "conn-1",
    refreshSchemaAndTables: m.refresh,
  }),
}));

import { useDropDatabaseObject } from "./useDropDatabaseObject";
import { useObjectDraftStore } from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import { editDraftKey, windowIdForDraftKey } from "src/lib/objectDraftKey";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";

const fn: DatabaseObjectItem = {
  id: "function:public:recalc::",
  kind: "function",
  schema: "public",
  name: "recalc",
  signature: "",
  capability: { canDelete: true },
} as unknown as DatabaseObjectItem;

const draftKey = editDraftKey(fn.id);
const windowId = windowIdForDraftKey(draftKey);

beforeEach(() => {
  vi.clearAllMocks();
  resetTabRuntimes();
  seedTabRuntime({ tabId: "tab-1", runtimeId: "conn-1" });
  m.confirmDialog.mockResolvedValue(true);
  m.runSqlQuery.mockResolvedValue({ rows: [] });
  useObjectDraftStore.setState({ drafts: {} });
  useObjectDraftStore.getState().ensureEditDraft("tab-1", draftKey, fn);
  useObjectDraftStore.getState().setSql("tab-1", draftKey, "-- edited");
  useScreenStore.setState({
    openWindows: {
      "tab-1": [{ id: windowId, type: "object" } as unknown as OpenWindow],
    },
  });
});

const draftKept = () =>
  !!useObjectDraftStore.getState().drafts["tab-1"]?.[draftKey];
const windowKept = () =>
  (useScreenStore.getState().openWindows["tab-1"] ?? []).some(
    (w) => w.id === windowId
  );

async function drop() {
  const { result } = renderHook(() => useDropDatabaseObject("tab-1"));
  await act(async () => {
    await result.current.dropObject(fn);
  });
}

describe("dropping a database object on the tab's own connection (D3)", () => {
  it("drops it and removes its draft and window", async () => {
    await drop();
    expect(m.runSqlQuery).toHaveBeenCalledWith(
      "conn-1",
      expect.stringContaining("DROP FUNCTION")
    );
    expect(draftKept()).toBe(false);
    expect(windowKept()).toBe(false);
  });

  it("asks nothing and sends nothing when the tab's target is unknown", async () => {
    useScreenStore
      .getState()
      .updateTab("tab-1", { target: { kind: "unknown" } });
    await drop();
    expect(m.confirmDialog).not.toHaveBeenCalled();
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(draftKept()).toBe(true);
    expect(m.showToast).toHaveBeenCalledWith(
      expect.stringContaining("could not be determined"),
      { tone: "error" }
    );
  });

  it("sends no DROP when the tab reconnects during the confirmation", async () => {
    m.confirmDialog.mockImplementation(async () => {
      seedTabRuntime({ tabId: "tab-1", runtimeId: "conn-2" });
      return true;
    });
    await drop();
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(draftKept()).toBe(true);
    expect(windowKept()).toBe(true);
    expect(m.showToast).toHaveBeenCalledWith(
      expect.stringContaining("Reconnect"),
      { tone: "error" }
    );
  });

  it("sends no DROP when the tab is switched to another database during the confirmation", async () => {
    m.confirmDialog.mockImplementation(async () => {
      useScreenStore.getState().updateTab("tab-1", {
        target: { kind: "override", database: "other" },
      });
      return true;
    });
    await drop();
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(draftKept()).toBe(true);
  });

  it("leaves drafts and windows alone when the tab reconnected while the DROP ran", async () => {
    m.runSqlQuery.mockImplementation(async () => {
      seedTabRuntime({ tabId: "tab-1", runtimeId: "conn-2" });
      useScreenStore.getState().bumpTabEpochs(["tab-1"]);
      return { rows: [] };
    });
    await drop();
    expect(m.runSqlQuery).toHaveBeenCalledTimes(1);
    expect(draftKept()).toBe(true);
    expect(windowKept()).toBe(true);
    expect(m.refresh).not.toHaveBeenCalled();
    expect(m.showToast).not.toHaveBeenCalled();
  });
});
