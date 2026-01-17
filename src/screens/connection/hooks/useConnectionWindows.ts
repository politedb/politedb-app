import { useCallback, useMemo } from "preact/hooks";
import { v4 as uuid } from "uuid";
import type {
  OpenWindow,
  SqlEditorWindow,
  TableItem,
  TableWindow,
} from "src/types";
import { useScreenStore } from "src/stores/screen";
import { useLoadTableData, tableKey } from "src/hooks/useLoadTableData";
import { useConnectionStore } from "src/stores/connection";
import { connectionRemove } from "src/lib/tauri";

/* =============================================================================
 * Helpers
 * ============================================================================= */

function makeTableKeyLocal(table: Pick<TableItem, "schema" | "name">) {
  return `${table.schema}.${table.name}`;
}

function makeTableWindowId(table: Pick<TableItem, "schema" | "name">) {
  return `table:${makeTableKeyLocal(table)}:${uuid()}`;
}

function isTableWindow(w: OpenWindow | undefined): w is TableWindow {
  return !!w && w.type === "table";
}

function isSqlWindow(w: OpenWindow | undefined): w is SqlEditorWindow {
  return !!w && w.type === "sql";
}

/* =============================================================================
 * Hook
 * ============================================================================= */

export function useConnectionWindows(activeProfileScreen: string) {
  const {
    profileTabs,
    openWindows,
    addWindow,
    removeWindow,
    activeWindowId,
    setActiveWindowId,
  } = useScreenStore();

  const { loadTableData, removeTableData } = useLoadTableData();

  const activeTab = useMemo(
    () => profileTabs.find((tab) => tab.id === activeProfileScreen) ?? null,
    [profileTabs, activeProfileScreen]
  );

  const windows = useMemo<OpenWindow[]>(
    () => openWindows[activeProfileScreen] || [],
    [openWindows, activeProfileScreen]
  );

  const activeId = activeWindowId[activeProfileScreen] ?? null;

  const activeWindow = useMemo<OpenWindow | undefined>(() => {
    if (!activeId) return undefined;
    return windows.find((w) => w.id === activeId);
  }, [windows, activeId]);

  const activeTableWindow = useMemo<TableWindow | undefined>(() => {
    return isTableWindow(activeWindow) ? activeWindow : undefined;
  }, [activeWindow]);

  const activeSqlWindow = useMemo<SqlEditorWindow | undefined>(() => {
    return isSqlWindow(activeWindow) ? activeWindow : undefined;
  }, [activeWindow]);

  const selectWindow = useCallback(
    (id: string | null) => {
      setActiveWindowId(activeProfileScreen, id);
    },
    [activeProfileScreen, setActiveWindowId]
  );

  const openSqlEditor = useCallback(() => {
    const id = `sql:${uuid()}`;
    const win: SqlEditorWindow = {
      id,
      type: "sql",
      title: "SQL Query",
      content: "",
    };
    addWindow(activeProfileScreen, win);
    setActiveWindowId(activeProfileScreen, win.id);
  }, [activeProfileScreen, addWindow, setActiveWindowId]);

  const openTable = useCallback(
    async (table: TableItem) => {
      const existing = windows.find(
        (w) =>
          w.type === "table" &&
          w.table.schema === table.schema &&
          w.table.name === table.name
      );

      if (existing) {
        setActiveWindowId(activeProfileScreen, existing.id);
        return existing.id;
      }

      const win: TableWindow = {
        id: makeTableWindowId(table),
        type: "table",
        table,
      };

      addWindow(activeProfileScreen, win);
      setActiveWindowId(activeProfileScreen, win.id);

      if (!table.new) {
        await loadTableData(table.schema, table.name);
      }

      return win.id;
    },
    [activeProfileScreen, windows, addWindow, setActiveWindowId, loadTableData]
  );

  const closeWindow = useCallback(
    async (windowId: string, e?: MouseEvent) => {
      e?.stopPropagation?.();

      const toClose = windows.find((w) => w.id === windowId);

      if (toClose?.type === "table") {
        const { schema, name } = toClose.table;
        const k = tableKey(activeProfileScreen, schema, name);
        const entry = useConnectionStore.getState().tableDataMap[k];
        const connectionId = entry?.connectionId ?? null;

        // remove cached UI data immediately
        removeTableData(schema, name);

        // drop per-table runtime connection if any
        if (connectionId) {
          try {
            await connectionRemove(connectionId);
          } catch (err) {
            console.error("Error removing connection:", err);
          }
        }
      }

      // If you still keep legacy sqlResults store, clear it here
      if (toClose?.type === "sql") {
        const clearSqlResult = useConnectionStore.getState().clearSqlResult;
        clearSqlResult?.(windowId);
      }

      removeWindow(activeProfileScreen, windowId);

      const currActive = activeWindowId[activeProfileScreen];
      if (currActive === windowId) {
        const remaining = windows.filter((w) => w.id !== windowId);
        setActiveWindowId(
          activeProfileScreen,
          remaining.length ? remaining[remaining.length - 1].id : null
        );
      }
    },
    [
      windows,
      activeProfileScreen,
      removeTableData,
      removeWindow,
      activeWindowId,
      setActiveWindowId,
    ]
  );

  const hasAnyWindow = windows.length > 0;

  return {
    activeTab,

    windows,
    hasAnyWindow,

    activeId,
    activeWindow,
    activeTableWindow,
    activeSqlWindow,

    selectWindow,
    openSqlEditor,
    openTable,
    closeWindow,
    makeTableWindowId,
  };
}
