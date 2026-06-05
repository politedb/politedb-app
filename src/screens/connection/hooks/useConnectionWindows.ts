import { useCallback, useMemo } from "preact/hooks";
import type {
  OpenWindow,
  SqlEditorWindow,
  TableItem,
  TableWindow,
} from "src/types";
import { useScreenStore } from "src/stores/screen";
import { useLoadTableData } from "src/hooks/useLoadTableData";
import { useConnectionStore } from "src/stores/connection";
import { PatchData } from "src/utils/generateSql";
import { getLiveSqlEditorContent } from "src/components/editor/SqlEditorPane";
import { clearSqlRunnerWindowState } from "./useSqlRunner";

/* =============================================================================
 * Helpers
 * ============================================================================= */

function makeTableKeyLocal(table: Pick<TableItem, "schema" | "name">) {
  return `${table.schema}.${table.name}`;
}

function makeTableWindowId(table: Pick<TableItem, "schema" | "name">) {
  // Use deterministic ID based on schema and table name so patches persist across close/reopen
  return `table:${makeTableKeyLocal(table)}`;
}

function makeDefaultSqlWindowId(profileId: string) {
  const safeProfileId = profileId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `sql-${safeProfileId}-default`;
}

function isTableWindow(w: OpenWindow | undefined): w is TableWindow {
  return !!w && w.type === "table";
}

function isSqlWindow(w: OpenWindow | undefined): w is SqlEditorWindow {
  return !!w && w.type === "sql";
}

const lastClosedSqlByTab = new Map<
  string,
  Pick<SqlEditorWindow, "content" | "title">
>();

const lastClosedSqlByScope = new Map<
  string,
  Pick<SqlEditorWindow, "content" | "title">
>();

const lastClosedSqlByProfile = new Map<
  string,
  Pick<SqlEditorWindow, "content" | "title">
>();

/* =============================================================================
 * Hook
 * ============================================================================= */

export function useConnectionWindows(
  activeProfileScreen: string,
  sqlScopeKey?: string
) {
  const {
    profileTabs,
    openWindows,
    addWindow,
    removeWindow,
    activeWindowId,
    setActiveWindowId,
  } = useScreenStore();

  const { removeTableData } = useLoadTableData();

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
    const scopeKey = sqlScopeKey ?? activeTab?.profileId ?? activeProfileScreen;
    const tabKey = activeProfileScreen;
    const profileKey = activeTab?.profileId ?? activeProfileScreen;
    const id = makeDefaultSqlWindowId(scopeKey);
    const tabScopedId = makeDefaultSqlWindowId(tabKey);
    const legacyId = makeDefaultSqlWindowId(profileKey);
    const existing = windows.find(
      (w) =>
        w.type === "sql" &&
        (w.id === id ||
          (tabScopedId !== id && w.id === tabScopedId) ||
          (legacyId !== id && w.id === legacyId))
    );
    if (existing) {
      setActiveWindowId(activeProfileScreen, existing.id);
      return existing.id;
    }

    const lastClosed =
      lastClosedSqlByScope.get(scopeKey) ??
      lastClosedSqlByTab.get(activeProfileScreen) ??
      lastClosedSqlByProfile.get(profileKey);
    const win: SqlEditorWindow = {
      id,
      type: "sql",
      title: lastClosed?.title ?? "SQL Query",
      content: lastClosed?.content ?? "",
    };
    addWindow(activeProfileScreen, win);
    setActiveWindowId(activeProfileScreen, win.id);
    return win.id;
  }, [
    activeProfileScreen,
    activeTab?.profileId,
    sqlScopeKey,
    windows,
    addWindow,
    setActiveWindowId,
  ]);

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
        useConnectionStore.getState().resetRows(makeTableWindowId(table));
      }

      return win.id;
    },
    [activeProfileScreen, windows, addWindow, setActiveWindowId]
  );

  const closeWindow = useCallback(
    async (windowId: string, e?: MouseEvent) => {
      e?.stopPropagation?.();

      const toClose = windows.find((w) => w.id === windowId);

      if (toClose?.type === "table") {
        const { schema, name } = toClose.table;

        // remove cached UI data immediately
        removeTableData(schema, name);

        // NOTE - DO NOT close per-table runtime connection here anymore since we're using runtimeConnection for table/window
        // drop per-table runtime connection if any
        // const k = tableKey(activeProfileScreen, schema, name);
        // const entry = useConnectionStore.getState().tableDataMap[k];
        // const connectionId = entry?.connectionId ?? null;
        // if (connectionId) {
        //   try {
        //     await connectionRemove(connectionId);
        //   } catch (err) {
        //     console.error("Error removing connection:", err);
        //   }
        // }
      }

      // If you still keep legacy sqlResults store, clear it here
      if (toClose?.type === "sql") {
        const liveContent = getLiveSqlEditorContent(windowId);
        const lastClosed = {
          content: liveContent ?? toClose.content ?? "",
          title: toClose.title ?? "SQL Query",
        };
        lastClosedSqlByTab.set(activeProfileScreen, lastClosed);
        if (sqlScopeKey) {
          lastClosedSqlByScope.set(sqlScopeKey, lastClosed);
        }
        if (activeTab?.profileId) {
          lastClosedSqlByProfile.set(activeTab.profileId, lastClosed);
        }
        const clearSqlResult = useConnectionStore.getState().clearSqlResult;
        clearSqlResult?.(windowId);
        clearSqlRunnerWindowState(windowId);
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
      sqlScopeKey,
      activeTab?.profileId,
      removeTableData,
      removeWindow,
      activeWindowId,
      setActiveWindowId,
    ]
  );

  const windowHasPatchChanges = useCallback(
    (entry: { patches?: PatchData | null } | undefined): boolean => {
      if (!entry?.patches) return false;
      const patches = entry.patches;
      for (const action of Object.keys(patches)) {
        const key = patches[action];
        if (!key || typeof key !== "object") continue;
        for (const dataKey of Object.keys(key)) {
          const rows = key[dataKey];
          if (rows && typeof rows === "object" && Object.keys(rows).length > 0)
            return true;
        }
      }
      return false;
    },
    []
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
    windowHasPatchChanges,
  };
}
