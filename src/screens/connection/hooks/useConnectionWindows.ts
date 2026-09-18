import { useCallback, useMemo } from "preact/hooks";
import type {
  DatabaseCatalogKind,
  DatabaseCatalogWindow,
  DatabaseObjectItem,
  DatabaseObjectKind,
  DatabaseObjectManagerWindow,
  OpenWindow,
  SqlEditorWindow,
  TableItem,
  TableWindow,
} from "src/types";
import { useScreenStore } from "src/stores/screen";
import { useLoadTableData } from "src/hooks/useLoadTableData";
import { useConnectionStore } from "src/stores/connection";
import { PatchData } from "src/utils/generateSql";
import {
  consumeUndrainedSqlForLiveEditor,
  getLiveSqlEditorContent,
} from "src/components/editor/liveSqlEditorRegistry";
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

function isObjectManagerWindow(
  w: OpenWindow | undefined
): w is DatabaseObjectManagerWindow {
  return !!w && w.type === "db-object-manager";
}

function isCatalogWindow(
  w: OpenWindow | undefined
): w is DatabaseCatalogWindow {
  return !!w && w.type === "db-catalog";
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
    updateWindow,
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

  const activeObjectManagerWindow = useMemo<
    DatabaseObjectManagerWindow | undefined
  >(() => {
    return isObjectManagerWindow(activeWindow) ? activeWindow : undefined;
  }, [activeWindow]);

  const activeCatalogWindow = useMemo<DatabaseCatalogWindow | undefined>(() => {
    return isCatalogWindow(activeWindow) ? activeWindow : undefined;
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

  const openDatabaseObjectsManager = useCallback(
    (opts?: { kind?: DatabaseObjectKind; object?: DatabaseObjectItem }) => {
      const id = "db-object-manager";
      const existing = windows.find((w) => w.type === "db-object-manager");
      const createTitle =
        opts?.kind === "trigger"
          ? "new_trigger"
          : opts?.kind
            ? `new_${opts.kind}`
            : "Database Objects";
      const patch = {
        initialKind: opts?.kind ?? opts?.object?.kind,
        // Use "" so create mode clears a previous object id (undefined can be dropped on merge/persist).
        initialObjectId: opts?.object?.id ?? "",
        title: opts?.object?.name ?? createTitle,
      } satisfies Partial<DatabaseObjectManagerWindow>;

      if (existing && existing.type === "db-object-manager") {
        updateWindow(activeProfileScreen, existing.id, patch);
        setActiveWindowId(activeProfileScreen, existing.id);
        return existing.id;
      }

      const win: DatabaseObjectManagerWindow = {
        id,
        type: "db-object-manager",
        title: opts?.object?.name ?? createTitle,
        initialKind: opts?.kind ?? opts?.object?.kind,
        initialObjectId: opts?.object?.id ?? "",
      };
      addWindow(activeProfileScreen, win);
      setActiveWindowId(activeProfileScreen, win.id);
      return win.id;
    },
    [activeProfileScreen, windows, addWindow, updateWindow, setActiveWindowId]
  );

  const openDatabaseCatalog = useCallback(
    (catalogKind: DatabaseCatalogKind, schema?: string) => {
      const schemaName = schema?.trim() || undefined;
      const id = schemaName
        ? `db-catalog:${catalogKind}:${schemaName}`
        : `db-catalog:${catalogKind}`;
      const baseTitle =
        catalogKind === "tables"
          ? "Tables"
          : catalogKind === "functions"
            ? "Functions"
            : catalogKind === "procedures"
              ? "Procedures"
              : "Triggers";
      const title = schemaName ? `${baseTitle}.${schemaName}` : baseTitle;
      const existing = windows.find(
        (w) =>
          w.type === "db-catalog" &&
          w.catalogKind === catalogKind &&
          (w.schema ?? "") === (schemaName ?? "")
      );

      if (existing && existing.type === "db-catalog") {
        updateWindow(activeProfileScreen, existing.id, {
          title,
          catalogKind,
          schema: schemaName,
        });
        setActiveWindowId(activeProfileScreen, existing.id);
        return existing.id;
      }

      const win: DatabaseCatalogWindow = {
        id,
        type: "db-catalog",
        title,
        catalogKind,
        schema: schemaName,
      };
      addWindow(activeProfileScreen, win);
      setActiveWindowId(activeProfileScreen, win.id);
      return win.id;
    },
    [activeProfileScreen, windows, addWindow, updateWindow, setActiveWindowId]
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
        const pendingSql = consumeUndrainedSqlForLiveEditor(windowId);
        let content = liveContent ?? toClose.content ?? "";
        for (const sql of pendingSql) {
          content = content.trim() ? `${content.trim()}\n\n${sql}` : sql;
        }
        const lastClosed = {
          content,
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
    activeObjectManagerWindow,
    activeCatalogWindow,

    selectWindow,
    openSqlEditor,
    openTable,
    openDatabaseObjectsManager,
    openDatabaseCatalog,
    closeWindow,
    makeTableWindowId,
    windowHasPatchChanges,
  };
}
