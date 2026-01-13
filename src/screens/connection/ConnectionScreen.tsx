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

type PatchMap = Record<string, Record<string, Record<string, any>>>;

export function ConnectionScreen() {
  const { activeProfileScreen } = useScreenStore();

  const [patchMap, setPatchMap] = useState<PatchMap>({});
  const { loadTableData, getTableData } = useLoadTableData();
  const { viewMode, toggleViewMode } = useViewMode(["left"]);
  const { sqlHistory, runSqlWithHistory, clearHistory } = useSqlHistoryRunner();

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

  /* =========================
   * Left panel: schemas/tables/search/filter/load
   * ========================= */
  const {
    tabTables,
    tabSchemas,
    activeSchema,
    onSchemaChange,
    tableSearchQuery,
    setTableSearchQuery,
    expandedSections,
    setExpandedSections,
    filteredTables,
    schemasForEditor,
    tablesForEditor,
    isConnecting,
    refreshSchemaAndTables,
  } = useSchemaTablesPanel({
    activeProfileScreen,
    activeTabId: activeTab?.id,
  });

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

  // Wrap close to cleanup local patchMap
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
    await refreshSchemaAndTables();

    if (!activeTableWindow) return;

    await loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [refreshSchemaAndTables, activeTableWindow, loadTableData]);

  // connectionId for SQL editor
  const runtimeConnectionId = useMemo(() => {
    if (activeTab?.runtimeConnectionId) return activeTab.runtimeConnectionId;
    return activeTableMapEntry?.connectionId ?? null;
  }, [activeTab?.runtimeConnectionId, activeTableMapEntry?.connectionId]);

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

  if (isConnecting) {
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
            schemas={tabSchemas?.data ?? []}
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
                engine={activeTab?.engine || "postgres"}
                activeSqlWindow={activeSqlWindow}
                activeTableWindow={activeTableWindow}
                activeTableData={activeTableData}
                loadError={loadError}
                hasAnyWindow={hasAnyWindow}
                onNewSql={handleOpenSqlEditor}
                onCellChange={handleCellChange}
                runtimeConnectionId={runtimeConnectionId}
                schemas={schemasForEditor}
                tables={tablesForEditor}
                onRunSql={runSqlWithHistory}
                patchMap={patchMap}
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
