import { useState, useMemo, useCallback, useEffect } from "preact/hooks";
import { v4 as uuid } from "uuid";
import { useLoadTables } from "src/hooks/useLoadTables";
import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { useScreenStore } from "src/stores/screen";
import { useConnectionStore } from "src/stores/connection";
import { connectionRemove } from "src/lib/tauri";
import { MenuBar } from "./MenuBar";
import { LeftNav } from "./LeftNav";
import { NavigationTabs } from "./NavigationTabs";
import { RightNav } from "./RightNav";
import { QueryHistory } from "./QueryHistory";
import { Box } from "src/components/common/Box";
import { cn } from "src/utils/cn";
import {
  TabViewMode,
  SqlQuery,
  OpenWindow,
  TableWindow,
  SqlEditorWindow,
  TableItem,
} from "src/types";
import { ActiveWindowContent } from "./ActiveWindowContent";
import { runSqlQuery } from "src/utils/query";
import type { QueryResult } from "src/lib/tauri";

type PatchMap = Record<string, Record<string, Record<string, any>>>;

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

export function ConnectionScreen() {
  const {
    activeProfileScreen,
    profileTabs,
    openWindows,
    addWindow,
    removeWindow,
    activeWindowId,
    setActiveWindowId,
  } = useScreenStore();

  const tabTables = useConnectionStore((s) => s.tables[activeProfileScreen]);
  const tabSchemas = useConnectionStore((s) => s.schemas[activeProfileScreen]);

  const [_patchMap, setPatchMap] = useState<PatchMap>({});
  const [tableSearchQuery, setTableSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<TabViewMode[]>(["left"]);
  const [sqlHistory, setSqlHistory] = useState<SqlQuery[]>([]);
  const [activeSchema, setActiveSchema] = useState("public");
  const [expandedSections, setExpandedSections] = useState({
    functions: false,
    tables: true,
  });

  const { loadSchemaAndTables } = useLoadTables();
  const { loadTableData, getTableData, removeTableData } = useLoadTableData();

  const activeTab = useMemo(
    () => profileTabs.find((tab) => tab.id === activeProfileScreen) ?? null,
    [profileTabs, activeProfileScreen]
  );

  const activeWindows = useMemo<OpenWindow[]>(
    () => openWindows[activeProfileScreen] || [],
    [openWindows, activeProfileScreen]
  );

  const activeWindow = useMemo<OpenWindow | undefined>(() => {
    const id = activeWindowId[activeProfileScreen];
    if (!id) return undefined;
    return activeWindows.find((w) => w.id === id);
  }, [activeWindows, activeProfileScreen, activeWindowId]);

  const activeTableWindow = useMemo<TableWindow | undefined>(() => {
    return isTableWindow(activeWindow) ? activeWindow : undefined;
  }, [activeWindow]);

  const activeSqlWindow = useMemo<SqlEditorWindow | undefined>(() => {
    return isSqlWindow(activeWindow) ? activeWindow : undefined;
  }, [activeWindow]);

  const activeTableData = useMemo(() => {
    if (!activeTableWindow) {
      return {
        data: null,
        sizeInfo: null,
        busy: false,
        error: null,
        connectionId: null,
      };
    }
    return getTableData(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [activeProfileScreen, activeTableWindow, getTableData]);

  // Active table entry (connectionId fallback)
  const activeTableMapEntry = useConnectionStore((s) => {
    if (!activeTableWindow) return null;
    const k = tableKey(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
    return s.tableDataMap[k] ?? null;
  });

  const filteredTables = useMemo(() => {
    const list = tabTables?.data ?? [];
    const q = tableSearchQuery.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (t) =>
        t.name.toLowerCase().includes(q) || t.schema.toLowerCase().includes(q)
    );
  }, [tabTables, tableSearchQuery]);

  const isConnecting = useMemo(() => {
    return (
      (tabTables?.busy && (tabTables?.data?.length ?? 0) === 0) ||
      (tabSchemas?.busy && (tabSchemas?.data?.length ?? 0) === 0)
    );
  }, [tabTables, tabSchemas]);

  const loadError = useMemo(() => {
    return (
      tabTables?.error ||
      tabSchemas?.error ||
      (activeTableWindow ? activeTableData.error : null)
    );
  }, [
    tabTables?.error,
    tabSchemas?.error,
    activeTableWindow,
    activeTableData.error,
  ]);

  useEffect(() => {
    if (!activeTab) return;
    void loadSchemaAndTables(activeSchema);
  }, [activeTab?.id, activeSchema, loadSchemaAndTables]);

  const handleSchemaChange = useCallback(
    async (schema: string) => {
      setActiveSchema(schema);
      await loadSchemaAndTables(schema);
    },
    [loadSchemaAndTables]
  );

  const handleViewModeChange = useCallback((mode: TabViewMode) => {
    setViewMode((prev) =>
      prev.includes(mode) ? prev.filter((m) => m !== mode) : [...prev, mode]
    );
  }, []);

  const handleOpenSqlEditor = useCallback(() => {
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

  const handleSelectTable = useCallback(
    async (table: TableItem) => {
      const existing = activeWindows.find(
        (w) =>
          w.type === "table" &&
          w.table.schema === table.schema &&
          w.table.name === table.name
      );

      if (existing) {
        setActiveWindowId(activeProfileScreen, existing.id);
        return;
      }

      const win: TableWindow = {
        id: makeTableWindowId(table),
        type: "table",
        table,
      };

      addWindow(activeProfileScreen, win);
      setActiveWindowId(activeProfileScreen, win.id);

      await loadTableData(table.schema, table.name);
    },
    [
      activeProfileScreen,
      activeWindows,
      addWindow,
      setActiveWindowId,
      loadTableData,
    ]
  );

  const handleCloseWindow = useCallback(
    async (windowId: string, e: MouseEvent) => {
      e.stopPropagation();

      const toClose = activeWindows.find((w) => w.id === windowId);

      if (toClose?.type === "table") {
        const { schema, name } = toClose.table;
        const k = tableKey(activeProfileScreen, schema, name);
        const entry = useConnectionStore.getState().tableDataMap[k];
        const connectionId = entry?.connectionId ?? null;

        removeTableData(schema, name);

        if (connectionId) {
          try {
            await connectionRemove(connectionId);
          } catch (err) {
            console.error("Error removing connection:", err);
          }
        }
      }

      // If you still keep legacy sqlResults store, you can clear it here
      if (toClose?.type === "sql") {
        const clearSqlResult = useConnectionStore.getState().clearSqlResult;
        clearSqlResult?.(windowId);
      }

      removeWindow(activeProfileScreen, windowId);

      const currActive = activeWindowId[activeProfileScreen];
      if (currActive === windowId) {
        const remaining = activeWindows.filter((w) => w.id !== windowId);
        setActiveWindowId(
          activeProfileScreen,
          remaining.length ? remaining[remaining.length - 1].id : null
        );
      }

      setPatchMap((prev) => {
        if (!prev[windowId]) return prev;
        const next = { ...prev };
        delete next[windowId];
        return next;
      });
    },
    [
      activeWindows,
      activeProfileScreen,
      removeTableData,
      removeWindow,
      activeWindowId,
      setActiveWindowId,
    ]
  );

  const handleCellChange = useCallback(
    (rowIndex: number, columnIndex: number, value: any) => {
      if (!activeTableWindow) return;

      const windowId = activeTableWindow.id;
      const rowKey = String(rowIndex);
      const columnKey = String(columnIndex);

      setPatchMap((prev) => ({
        ...prev,
        [windowId]: {
          ...(prev[windowId] ?? {}),
          [rowKey]: {
            ...((prev[windowId] ?? {})[rowKey] ?? {}),
            [columnKey]: value,
          },
        },
      }));
    },
    [activeTableWindow]
  );

  const handleRefresh = useCallback(async () => {
    await loadSchemaAndTables(activeSchema);
    if (!activeTableWindow) return;

    await loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [activeSchema, activeTableWindow, loadSchemaAndTables, loadTableData]);

  // ✅ connectionId for SQL editor
  const runtimeConnectionId = useMemo(() => {
    if (activeTab?.runtimeConnectionId) return activeTab.runtimeConnectionId;
    return activeTableMapEntry?.connectionId ?? null;
  }, [activeTab?.runtimeConnectionId, activeTableMapEntry?.connectionId]);

  const schemasForEditor = useMemo(() => tabSchemas?.data ?? [], [tabSchemas]);
  const tablesForEditor = useMemo(() => tabTables?.data ?? [], [tabTables]);

  // ✅ IMPORTANT: return QueryResult (for result slots fill)
  const handleRunSql = useCallback(
    async ({
      connectionId,
      sql,
    }: {
      connectionId: string;
      sql: string;
    }): Promise<QueryResult> => {
      // 1) store history (keep)
      setSqlHistory((prev) => [
        { id: uuid(), sql, createdAt: Date.now() } as unknown as SqlQuery,
        ...prev,
      ]);

      // 2) execute and return result (ActiveWindowContent will handle slots & UI)
      const res = await runSqlQuery(connectionId, sql);
      return res;
    },
    []
  );

  if (!activeTab) {
    return (
      <Box className="bg-neutral-100 text-center">
        <p class="text-neutral-500">No connection selected</p>
      </Box>
    );
  }

  if (isConnecting) {
    return (
      <Box className="bg-neutral-100 text-center">
        <p class="text-neutral-500">Connecting to {activeTab.label}...</p>
      </Box>
    );
  }

  return (
    <div class="flex h-full flex-1 flex-col">
      <MenuBar
        activeSchema={activeTableWindow?.table.schema}
        activeTable={activeTableWindow?.table.name}
        viewMode={viewMode}
        loadTableError={loadError}
        onViewModeChange={handleViewModeChange}
        openSQLWindow={handleOpenSqlEditor}
        onRefresh={handleRefresh}
      />

      <div class="flex h-full flex-1 overflow-hidden">
        {viewMode.includes("left") && (
          <LeftNav
            schemas={tabSchemas?.data ?? []}
            currSchema={activeSchema}
            onSchemaChange={handleSchemaChange}
            tableSearchQuery={tableSearchQuery}
            setTableSearchQuery={setTableSearchQuery}
            expandedSections={expandedSections}
            setExpandedSections={setExpandedSections}
            filteredTables={filteredTables}
            handleSelectTable={handleSelectTable}
            activeWindowId={activeWindowId[activeProfileScreen]}
          />
        )}

        <div
          class={cn(
            "transition-smooth flex flex-1 flex-col overflow-hidden bg-neutral-100",
            viewMode.includes("right") && "flex-row!"
          )}
        >
          <div class="transition-smooth flex flex-1 flex-col overflow-hidden">
            {activeWindows.length > 0 && (
              <div class={cn("flex shrink-0 items-end overflow-x-auto pt-1")}>
                <NavigationTabs
                  openWindows={activeWindows}
                  setActiveWindowId={(id) =>
                    setActiveWindowId(activeProfileScreen, id)
                  }
                  activeWindowId={activeWindowId[activeProfileScreen]}
                  handleCloseWindow={handleCloseWindow}
                />
              </div>
            )}

            <div
              class={cn(
                "flex-1 overflow-auto",
                viewMode.includes("left") && "animate-slide-in-right",
                viewMode.includes("right") && "animate-slide-in-left",
                viewMode.includes("bottom") && "animate-slide-in-up"
              )}
            >
              <ActiveWindowContent
                activeWindow={activeWindow}
                activeSqlWindow={activeSqlWindow}
                activeTableWindow={activeTableWindow}
                activeTableData={activeTableData}
                loadError={loadError}
                hasAnyWindow={activeWindows.length > 0}
                onNewSql={handleOpenSqlEditor}
                onCellChange={handleCellChange}
                runtimeConnectionId={runtimeConnectionId}
                schemas={schemasForEditor}
                tables={tablesForEditor}
                onRunSql={handleRunSql}
              />
            </div>

            {viewMode.includes("bottom") && (
              <div class="animate-slide-in-up h-64 shrink-0 border-t border-neutral-200">
                <QueryHistory
                  queries={sqlHistory}
                  onClear={() => setSqlHistory([])}
                  onSelectQuery={(query) => {
                    console.log("Selected query:", query);
                  }}
                />
              </div>
            )}
          </div>

          {viewMode.includes("right") && (
            <div class="animate-slide-in-left w-64 shrink-0 border-l border-neutral-200">
              <RightNav sizeInfo={activeTableData.sizeInfo} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
