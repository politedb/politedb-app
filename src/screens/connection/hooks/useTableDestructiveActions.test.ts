import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenWindow, TableItem } from "src/types";

const dialogs = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  showMessage: vi.fn(),
}));
vi.mock("src/lib/system-dialog", () => dialogs);

import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";
import { useScreenStore } from "src/stores/screen";
import {
  confirmDropTable,
  tableIdentity,
  useTableDestructiveActions,
} from "./useTableDestructiveActions";

const orders: TableItem = { schema: "public", name: "orders" };
const windows = [
  { id: "w-orders", type: "table", table: orders },
  { id: "w-orders-2", type: "table", table: { ...orders } },
  { id: "w-users", type: "table", table: { schema: "public", name: "users" } },
  { id: "w-sql", type: "sql", content: "" },
] as unknown as OpenWindow[];

function setup(
  overrides: Partial<{
    isProfileLocked: boolean;
    connectionId: string | null;
  }> = {}
) {
  const deps = {
    runSqlWithHistory: vi.fn().mockResolvedValue({ mode: "direct" }),
    refreshSchemaAndTables: vi.fn().mockResolvedValue(undefined),
    closeWindow: vi.fn().mockResolvedValue(undefined),
    markTableStale: vi.fn(),
  };
  const hook = renderHook(() =>
    useTableDestructiveActions({
      tabId: "tab-1",
      isProfileLocked: overrides.isProfileLocked ?? false,
      engine: "postgres",
      connectionId:
        "connectionId" in overrides ? overrides.connectionId : "conn-1",
      windows,
      ...deps,
    })
  );
  return { ...deps, hook };
}

beforeEach(() => {
  resetTabRuntimes();
  seedTabRuntime();
  dialogs.confirmDialog.mockReset().mockResolvedValue(true);
  dialogs.showMessage.mockReset().mockResolvedValue(undefined);
});

describe("confirmDropTable", () => {
  it("asks natively with a Drop button", async () => {
    await confirmDropTable("orders");

    expect(dialogs.confirmDialog).toHaveBeenCalledWith(
      expect.stringContaining('"orders"'),
      expect.objectContaining({
        title: "Drop table",
        kind: "warning",
        okLabel: "Drop",
        cancelLabel: "Cancel",
      })
    );
  });
});

describe("dropTable", () => {
  it("confirms natively, drops, refreshes and closes every view of that table", async () => {
    const { hook, runSqlWithHistory, refreshSchemaAndTables, closeWindow } =
      setup();

    await act(() => hook.result.current.dropTable(orders));

    expect(dialogs.confirmDialog).toHaveBeenCalledTimes(1);
    expect(runSqlWithHistory).toHaveBeenCalledWith({
      connectionId: "conn-1",
      sql: expect.stringMatching(/DROP TABLE .*orders/i),
      tabId: "tab-1",
    });
    expect(refreshSchemaAndTables).toHaveBeenCalledTimes(1);
    expect(closeWindow.mock.calls.map(([id]) => id)).toEqual([
      "w-orders",
      "w-orders-2",
    ]);
  });

  it("does nothing when the confirmation is cancelled", async () => {
    dialogs.confirmDialog.mockResolvedValue(false);
    const { hook, runSqlWithHistory, closeWindow } = setup();

    await act(() => hook.result.current.dropTable(orders));

    expect(runSqlWithHistory).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("never asks or drops on a locked connection or an unsaved table", async () => {
    const locked = setup({ isProfileLocked: true });
    await act(() => locked.hook.result.current.dropTable(orders));
    const draft = setup();
    await act(() =>
      draft.hook.result.current.dropTable({ ...orders, new: true })
    );

    expect(dialogs.confirmDialog).not.toHaveBeenCalled();
    expect(locked.runSqlWithHistory).not.toHaveBeenCalled();
    expect(draft.runSqlWithHistory).not.toHaveBeenCalled();
  });

  it("reports a failed drop natively and keeps the table's views open", async () => {
    const { hook, runSqlWithHistory, closeWindow, refreshSchemaAndTables } =
      setup();
    runSqlWithHistory.mockRejectedValue(new Error("permission denied"));

    await act(() => hook.result.current.dropTable(orders));

    expect(dialogs.showMessage).toHaveBeenCalledWith("permission denied", {
      title: "Error",
      kind: "error",
    });
    expect(refreshSchemaAndTables).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("reports a missing connection after the confirmation", async () => {
    const { hook, runSqlWithHistory } = setup({ connectionId: null });

    await act(() => hook.result.current.dropTable(orders));

    expect(runSqlWithHistory).not.toHaveBeenCalled();
    expect(dialogs.showMessage).toHaveBeenCalledWith(
      "Not connected.",
      expect.objectContaining({ kind: "error" })
    );
  });
});

describe("truncate", () => {
  it("opens the dialog target without a confirmation or SQL", () => {
    const { hook, runSqlWithHistory } = setup();

    act(() => hook.result.current.openTruncate(orders));

    expect(hook.result.current.truncateTarget).toEqual(orders);
    expect(dialogs.confirmDialog).not.toHaveBeenCalled();
    expect(runSqlWithHistory).not.toHaveBeenCalled();

    act(() => hook.result.current.closeTruncate());
    expect(hook.result.current.truncateTarget).toBeNull();
  });

  it("refuses to open on a locked connection or an unsaved table", () => {
    const locked = setup({ isProfileLocked: true });
    act(() => locked.hook.result.current.openTruncate(orders));
    const draft = setup();
    act(() => draft.hook.result.current.openTruncate({ ...orders, new: true }));

    expect(locked.hook.result.current.truncateTarget).toBeNull();
    expect(draft.hook.result.current.truncateTarget).toBeNull();
  });

  it("truncates with the chosen options and marks the table's views stale", async () => {
    const { hook, runSqlWithHistory, markTableStale } = setup();
    act(() => hook.result.current.openTruncate(orders));

    await act(() =>
      hook.result.current.confirmTruncate({
        restartIdentity: true,
        cascade: false,
      })
    );

    const [{ sql }] = runSqlWithHistory.mock.calls[0];
    expect(sql).toMatch(/TRUNCATE TABLE .*orders/i);
    expect(sql).toMatch(/RESTART IDENTITY/i);
    expect(sql).not.toMatch(/CASCADE/i);
    expect(markTableStale).toHaveBeenCalledWith(tableIdentity(orders));
  });

  it("lets the dialog report a failed truncate", async () => {
    const { hook, runSqlWithHistory, markTableStale } = setup();
    runSqlWithHistory.mockRejectedValue(new Error("locked by another session"));
    act(() => hook.result.current.openTruncate(orders));

    await expect(
      hook.result.current.confirmTruncate({
        restartIdentity: false,
        cascade: true,
      })
    ).rejects.toThrow("locked by another session");
    expect(markTableStale).not.toHaveBeenCalled();
  });
});

describe("drop and truncate on the tab's own connection (D3)", () => {
  it("asks nothing and drops nothing on a connection the tab no longer uses", async () => {
    seedTabRuntime({ runtimeId: "conn-2" });
    const { hook, runSqlWithHistory } = setup();
    await act(() => hook.result.current.dropTable(orders));
    expect(dialogs.confirmDialog).not.toHaveBeenCalled();
    expect(runSqlWithHistory).not.toHaveBeenCalled();
    expect(dialogs.showMessage.mock.calls[0]![0]).toContain(
      "no longer uses this connection"
    );
  });

  it("drops nothing when the tab reconnects during the confirmation", async () => {
    dialogs.confirmDialog.mockImplementation(async () => {
      seedTabRuntime({ runtimeId: "conn-2" });
      return true;
    });
    const { hook, runSqlWithHistory, closeWindow } = setup();
    await act(() => hook.result.current.dropTable(orders));
    expect(runSqlWithHistory).not.toHaveBeenCalled();
    expect(closeWindow).not.toHaveBeenCalled();
  });

  it("truncates nothing when the tab's target changed after the dialog opened", async () => {
    const { hook, runSqlWithHistory, markTableStale } = setup();
    act(() => hook.result.current.openTruncate(orders));
    useScreenStore.getState().updateTab("tab-1", {
      target: { kind: "override", database: "other" },
    });
    await expect(
      hook.result.current.confirmTruncate({
        restartIdentity: false,
        cascade: false,
      })
    ).rejects.toThrow("but is connected to");
    expect(runSqlWithHistory).not.toHaveBeenCalled();
    expect(markTableStale).not.toHaveBeenCalled();
  });

  it("does not open the truncate dialog on a tab whose target is unknown", () => {
    useScreenStore.getState().updateTab("tab-1", {
      target: { kind: "unknown" },
    });
    const { hook } = setup();
    act(() => hook.result.current.openTruncate(orders));
    expect(hook.result.current.truncateTarget).toBeNull();
  });
});

describe("tableIdentity", () => {
  it("separates schema and name unambiguously", () => {
    expect(tableIdentity({ schema: "a.b", name: "c" })).not.toBe(
      tableIdentity({ schema: "a", name: "b.c" })
    );
  });
});
