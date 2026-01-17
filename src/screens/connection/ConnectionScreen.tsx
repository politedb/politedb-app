import { useState, useMemo, useCallback } from "preact/hooks";
import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { useScreenStore } from "src/stores/screen";
import { useConnectionStore } from "src/stores/connection";
import { MenuBar } from "./MenuBar";
import { LeftNav } from "./LeftNav";
import { NavigationTabs } from "./NavigationTabs";
import { RightNav } from "./RightNav";
import { QueryHistory } from "./QueryHistory";
import { Box } from "src/components/common/Box";
import { cn } from "src/utils/cn";
import { TableItem } from "src/types";
import { ActiveWindowContent } from "./ActiveWindowContent";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { useViewMode } from "./hooks/useViewMode";
import { useSqlHistoryRunner } from "./hooks/useSqlHistoryRunner";
import { useSchemaTablesPanel } from "./hooks/useSchemaTablesPanel";
import { useDatabaseMetadata } from "src/hooks/useDatabaseMetadata";
import { useEnsureRuntimeConnection } from "../../hooks/useEnsureRuntimeConnection";

type PatchMap = Record<string, Record<string, Record<string, any>>>;

export function ConnectionScreen() {
  const { activeProfileScreen } = useScreenStore();

  const [patchMap, setPatchMap] = useState<PatchMap>({});
  const { loadTableData, getTableData } = useLoadTableData();
  const { viewMode, toggleViewMode } = useViewMode(["left"]);

  /* =========================
   * Windows orchestration
   * ========================= */
  const {
    activeTab,
    windows: activeWindows,
    hasAnyWindow,
    activeId,
    activeWindow,
    activeTableWindow,
    activeSqlWindow,
    selectWindow,
    openSqlEditor,
    openTable,
    closeWindow,
  } = useConnectionWindows(activeProfileScreen);

  const { connecting: connectingRuntime } =
    useEnsureRuntimeConnection(activeTab);

  const engine = activeTab?.engine;
  const [limit, setLimit] = useState(300);
  const [offset, setOffset] = useState(0);

  // Stable metaKey (NOT runtimeConnectionId)
  const metaKey = useMemo(() => {
    if (!activeTab?.profileId) return "";
    return `${engine ?? "postgres"}:${activeTab.profileId}`;
  }, [engine, activeTab?.profileId]);

  /* =========================
   * Active table data
   * ========================= */
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

  // runtime connection fallback (table window may have its own runtime conn)
  const activeTableMapEntry = useConnectionStore((s) => {
    if (!activeTableWindow) return null;
    const k = tableKey(
      activeProfileScreen,
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
    return s.tableDataMap[k] ?? null;
  });

  const runtimeConnectionId = useMemo(() => {
    if (activeTab?.runtimeConnectionId) return activeTab.runtimeConnectionId;
    return activeTableMapEntry?.connectionId || undefined;
  }, [activeTab?.runtimeConnectionId, activeTableMapEntry?.connectionId]);

  /* =========================
   * Metadata (single instance) + Left panel
   * ========================= */
  const metadata = useDatabaseMetadata();

  const {
    meta, // includes loading/progress/error
    activeSchema,
    onSchemaChange,
    refreshSchemaAndTables,

    tableSearchQuery,
    setTableSearchQuery,

    expandedSections,
    setExpandedSections,

    filteredTables,

    // ✅ for editor completion (full metadata)
    schemasForEditor,

    isConnecting,
  } = useSchemaTablesPanel({
    metadata, // ✅ IMPORTANT: use the same instance
    metaKey,
    engine,
    connectionId: runtimeConnectionId,
    defaultSchema: "public",
  });

  const loadError = useMemo(() => {
    return meta.error || (activeTableWindow ? activeTableData.error : null);
  }, [meta.error, activeTableWindow, activeTableData.error]);

  /* =========================
   * SQL execution + history + DDL invalidate
   * ========================= */
  const { sqlHistory, runSqlWithHistory, clearHistory } = useSqlHistoryRunner({
    engine,
    metadata, // ✅ same instance (DDL invalidation will affect panel/editor)
    profileId: activeProfileScreen,
  });

  const handlePageChange = useCallback(
    (limit: number, offset: number) => {
      setLimit(limit);
      setOffset(offset);

      if (!activeTableWindow) return;

      loadTableData(
        activeTableWindow.table.schema,
        activeTableWindow.table.name,
        { limit, offset }
      );
    },
    [activeTableWindow, loadTableData, setLimit, setOffset]
  );

  /* =========================
   * Actions
   * ========================= */
  const handleOpenSqlEditor = useCallback(() => {
    openSqlEditor();
  }, [openSqlEditor]);

  const handleSelectTable = useCallback(
    async (table: TableItem) => {
      await openTable(table);
    },
    [openTable]
  );

  const handleCloseWindow = useCallback(
    async (windowId: string, e: MouseEvent) => {
      await closeWindow(windowId, e);

      setPatchMap((prev) => {
        if (!prev[windowId]) return prev;
        const next = { ...prev };
        delete next[windowId];
        return next;
      });
    },
    [closeWindow]
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
    // refresh metadata (schemas/tables/columns) without changing UI state
    await refreshSchemaAndTables();

    // refresh active table data (rows)
    if (!activeTableWindow) return;

    await loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset }
    );
  }, [refreshSchemaAndTables, activeTableWindow, loadTableData]);

  /* =========================
   * Guards
   * ========================= */
  if (!activeTab) {
    return (
      <Box className="bg-neutral-100 text-center">
        <p class="text-neutral-500">No connection selected</p>
      </Box>
    );
  }

  if (isConnecting || connectingRuntime) {
    return (
      <Box className="bg-neutral-100 text-center">
        <p class="text-neutral-500">Connecting to {activeTab.label}...</p>
      </Box>
    );
  }

  /* =========================
   * UI
   * ========================= */
  return (
    <div class="flex h-full flex-1 flex-col">
      <MenuBar
        activeSchema={activeTableWindow?.table.schema}
        activeTable={activeTableWindow?.table.name}
        viewMode={viewMode}
        loadTableError={loadError}
        onViewModeChange={toggleViewMode}
        openSQLWindow={handleOpenSqlEditor}
        onRefresh={handleRefresh}
      />

      <div class="flex h-full flex-1 overflow-hidden">
        {viewMode.includes("left") && (
          <LeftNav
            schemas={schemasForEditor}
            currSchema={activeSchema}
            onSchemaChange={onSchemaChange}
            tableSearchQuery={tableSearchQuery}
            setTableSearchQuery={setTableSearchQuery}
            expandedSections={expandedSections}
            setExpandedSections={setExpandedSections}
            filteredTables={filteredTables}
            handleSelectTable={handleSelectTable}
            activeWindowId={activeId}
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
                  setActiveWindowId={(id) => selectWindow(id)}
                  activeWindowId={activeId}
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
                engine={engine || "postgres"}
                activeSqlWindow={activeSqlWindow}
                activeTableWindow={activeTableWindow}
                activeTableData={activeTableData}
                limit={limit}
                offset={offset}
                totalRows={activeTableData.data?.rowCount ?? 0}
                loadError={loadError}
                hasAnyWindow={hasAnyWindow}
                onNewSql={handleOpenSqlEditor}
                onCellChange={handleCellChange}
                runtimeConnectionId={runtimeConnectionId}
                onRunSql={runSqlWithHistory}
                patchMap={patchMap}
                metadata={metadata}
                metaKey={metaKey}
                onPageChange={handlePageChange}
              />
            </div>

            {viewMode.includes("bottom") && (
              <div class="animate-slide-in-up h-64 shrink-0 border-t border-neutral-200">
                <QueryHistory
                  queries={sqlHistory}
                  onClear={clearHistory}
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
