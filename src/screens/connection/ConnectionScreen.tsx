import {
  useState,
  useMemo,
  useCallback,
  useEffect,
  useRef,
} from "preact/hooks";
import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { useScreenStore } from "src/stores/screen";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { connectionRemove } from "src/lib/tauri";
import { MenuBar } from "./MenuBar";
import { LeftNav } from "./LeftNav";
import { NavigationTabs } from "./NavigationTabs";
import { RightNav } from "./RightNav";
import { QueryHistory } from "./QueryHistory";
import { Box } from "src/components/common/Box";
import { cn } from "src/utils/cn";
import type { TableItem } from "src/types";
import { ActiveWindowContent } from "./ActiveWindowContent";
import { useConnectionWindows } from "./hooks/useConnectionWindows";
import { useViewMode } from "./hooks/useViewMode";
import { useSqlHistoryRunner } from "./hooks/useSqlHistoryRunner";
import { useSchemaTablesPanel } from "./hooks/useSchemaTablesPanel";
import { useDatabaseMetadata } from "src/hooks/useDatabaseMetadata";
import { useEnsureRuntimeConnection } from "src/hooks/useEnsureRuntimeConnection";
import { SplitPane } from "src/components/SplitPane";
import { generateSqlFromPatches } from "src/utils/generateSql";
import { WarningRefreshDialog } from "src/components/modal/WarningRefreshDialog";
import { ErrorDialog } from "src/components/modal/ErrorDialog";
import { normalizeSqlError } from "src/utils/queryValidate";

export function ConnectionScreen() {
  const {
    activeProfileScreen,
    profileTabs,
    removeTab,
    setActiveProfileScreen,
    openWindows,
  } = useScreenStore();

  const {
    queryHistory,
    dataPatchMap,
    tableStructure,
    tableConstraints,
    setTableStructure,
    setTableConstraints,
    clearTableStructure,
    clearTableConstraints,
    clearQueryHistory: clearHistory,
    setDataPatchMap: setPatchMap,
    clearDataPatchMap: clearPatchMap,
    clearNewTableData,
    tableDataMap,
  } = useConnectionStore();

  const [limit, setLimit] = useState(300);
  const [offset, setOffset] = useState(0);
  const [warningRefresh, setWarningRefresh] = useState(false);
  const [pendingCloseTabId, setPendingCloseTabId] = useState<string | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);

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
  // ✅ only select tab-scoped data + active table entry (avoid rerender storms)

  const engine = activeTab?.engine;

  // Stable metaKey (NOT runtimeConnectionId)
  const metaKey = useMemo(() => {
    if (!activeTab?.profileId) return "";
    return `${engine ?? "postgres"}:${activeTab.profileId}`;
  }, [engine, activeTab?.profileId]);

  const [patchMap, sqlHistory] = useMemo(() => {
    return [
      dataPatchMap[activeProfileScreen] ?? {},
      queryHistory[activeProfileScreen] ?? [],
    ];
  }, [dataPatchMap, activeProfileScreen]);

  const [tableStructureData, tableConstraintsData] = useMemo(() => {
    if (!activeId) return [[], []];

    return [
      tableStructure[activeProfileScreen]?.[activeId] ?? [],
      tableConstraints[activeProfileScreen]?.[activeId] ?? [],
    ];
  }, [tableStructure, tableConstraints, activeProfileScreen, activeId]);

  const { loadTableData, getTableData, removeTableData } = useLoadTableData();

  /* =========================
   * Active table data
   * ========================= */
  const activeTableData = useMemo(() => {
    if (!activeTableWindow) {
      return {
        data: null,
        structure: null,
        constraints: null,
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

  // check if there are any patches to apply
  const hasPatches = useMemo(() => {
    // Check if any window has actual patches (not just empty objects)
    return Object.values(patchMap).some((windowData) => {
      if (!windowData?.patches) return false;
      const { patches } = windowData;
      // Check if patches has any actions with data
      return Object.values(patches).some((actionPatches) => {
        if (!actionPatches || typeof actionPatches !== "object") return false;
        // Check if any dataKey has entries
        return Object.values(actionPatches).some((dataKeyPatches) => {
          if (!dataKeyPatches || typeof dataKeyPatches !== "object")
            return false;
          // Check if any rowKey has entries
          return Object.keys(dataKeyPatches).length > 0;
        });
      });
    });
  }, [patchMap]);

  // check if we have new table data to save (reactive to store changes)
  const newTableData = useConnectionStore((s) => {
    if (!activeTableWindow || !activeId) return null;
    return s.newTableData[activeProfileScreen]?.[activeId] ?? null;
  });

  const hasNewTableData = useMemo(() => {
    if (!newTableData) return false;
    // Check if we have valid data (table name and at least one column)
    return (
      newTableData.tableName.trim().length > 0 &&
      newTableData.columns.some((col) => col.column_name.trim())
    );
  }, [newTableData]);

  // Ref to store the save function from NewTablePane
  const newTableSaveRef = useRef<(() => Promise<void>) | null>(null);

  /* =========================
   * SQL execution + history + DDL invalidate
   * ========================= */
  const { runSqlWithHistory } = useSqlHistoryRunner({
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

  const handleClearChanges = useCallback(
    (profileScreen: string, tableWindowId?: string) => {
      clearTableConstraints(profileScreen, tableWindowId);
      clearTableStructure(profileScreen, tableWindowId);
      clearPatchMap(profileScreen, tableWindowId);
      clearNewTableData(profileScreen, tableWindowId);
    },
    [
      clearTableConstraints,
      clearTableStructure,
      clearPatchMap,
      clearNewTableData,
    ]
  );

  // Check if a tab has any unsaved changes
  const tabHasChanges = useCallback(
    (tabId: string): boolean => {
      // Check for patches
      const tabPatches = dataPatchMap[tabId];
      if (tabPatches && Object.keys(tabPatches).length > 0) {
        return true;
      }

      // Check for new table data
      const tabNewTableData = useConnectionStore.getState().newTableData[tabId];
      if (tabNewTableData && Object.keys(tabNewTableData).length > 0) {
        // Check if any new table has valid data
        for (const windowId in tabNewTableData) {
          const newTable = tabNewTableData[windowId];
          if (
            newTable.tableName.trim().length > 0 &&
            newTable.columns.some((col) => col.column_name.trim())
          ) {
            return true;
          }
        }
      }

      return false;
    },
    [dataPatchMap]
  );

  const handleCloseWindow = useCallback(
    async (windowId: string, e: MouseEvent) => {
      await closeWindow(windowId, e);
    },
    [closeWindow]
  );

  const handleCloseConnectionTab = useCallback(
    async (tabId: string, skipCheck = false) => {
      // Check for unsaved changes if not skipping the check
      if (!skipCheck && tabHasChanges(tabId)) {
        setPendingCloseTabId(tabId);
        setWarningRefresh(true);
        return;
      }

      // Clear all changes for this tab before closing
      handleClearChanges(tabId);

      const currentTab = profileTabs.find((tab) => tab.id === tabId);
      const newTabs = profileTabs.filter((tab) => tab.id !== tabId);

      removeTab(tabId);

      if (activeProfileScreen === tabId) {
        setActiveProfileScreen(
          newTabs.length > 0 ? newTabs[newTabs.length - 1].id : "main"
        );
      }

      if (currentTab?.runtimeConnectionId) {
        try {
          await connectionRemove(currentTab.runtimeConnectionId);
        } catch (err) {
          console.error("Error removing runtime connection:", err);
        }
      }

      const windows = openWindows[tabId] ?? [];
      if (windows.length === 0) return;

      const tableWindows = windows.filter((w) => w.type === "table");

      await Promise.all(
        tableWindows.map(async (w) => {
          const { schema, name } = w.table;

          const key = tableKey(tabId, schema, name);
          const { connectionId } = tableDataMap[key] || { connectionId: null };

          removeTableData(schema, name);

          if (connectionId) {
            try {
              await connectionRemove(connectionId);
            } catch (err) {
              console.error("Error removing table connection:", err);
            }
          }
        })
      );
    },
    [
      profileTabs,
      removeTab,
      activeProfileScreen,
      setActiveProfileScreen,
      openWindows,
      tableDataMap,
      removeTableData,
      tabHasChanges,
      handleClearChanges,
    ]
  );

  const handleDataChange = useCallback(
    (
      action: DataAction,
      dataKey: DataKey,
      rowIndex: number,
      data: Record<string, any>
    ) => {
      if (!activeProfileScreen || !activeTableWindow) {
        return;
      }

      // For new rows (rowIndex === -1), extract the unique rowKey from data
      // Otherwise, use the rowIndex as the rowKey
      let rowKey: string;
      let patchData = data;

      if (rowIndex === -1 && data.__rowKey) {
        rowKey = data.__rowKey;
        // Remove __rowKey from the actual patch data
        const { __rowKey, ...rest } = data;
        patchData = rest;
      } else {
        rowKey = String(rowIndex);
      }

      setPatchMap(activeProfileScreen, {
        dataKey,
        action,
        tableData: activeTableData,
        tableWindow: activeTableWindow,
        rowKey,
        data: patchData,
      });
    },
    [
      activeProfileScreen,
      JSON.stringify(activeTableWindow),
      JSON.stringify(activeTableData),
      setPatchMap,
    ]
  );

  const handleRefresh = useCallback(async () => {
    if (hasPatches) {
      setWarningRefresh(true);
      return;
    }

    // refresh metadata (schemas/tables/columns) without changing UI state
    await refreshSchemaAndTables();

    // refresh active table data (rows)
    if (!activeTableWindow) return;

    await loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset }
    );
  }, [refreshSchemaAndTables, activeTableWindow, loadTableData, limit, offset]);

  const handleDiscardChanges = useCallback(async () => {
    if (pendingCloseTabId) {
      // Clear all changes for the tab
      handleClearChanges(pendingCloseTabId);
      // Close the tab (skip the check since we're discarding)
      await handleCloseConnectionTab(pendingCloseTabId, true);
    } else {
      handleClearChanges(activeProfileScreen);
    }

    setWarningRefresh(false);
    setPendingCloseTabId(null);
  }, [
    activeProfileScreen,
    pendingCloseTabId,
    handleCloseConnectionTab,
    handleClearChanges,
    setWarningRefresh,
    setPendingCloseTabId,
  ]);

  const handleSaveNewTable = useCallback(async () => {
    if (newTableSaveRef.current) {
      await newTableSaveRef.current();
    }
  }, []);

  const handleApplyPatches = useCallback(async () => {
    if (!activeTableWindow || !runtimeConnectionId) return;

    try {
      // Generate SQL from patches
      const sql = generateSqlFromPatches(patchMap, engine || "postgres");

      if (!sql.length) {
        // Clear patches after successful execution
        setError("An error occurred while applying patches.");
        return;
      }

      // Execute the SQL statements sequentially to maintain transaction integrity
      // and ensure proper ordering (DDL before DML, etc.)
      for (const sqlStatement of sql) {
        await runSqlWithHistory({
          connectionId: runtimeConnectionId,
          sql: sqlStatement,
        });
      }

      // Clear patches after successful execution
      handleClearChanges(activeProfileScreen, activeTableWindow.id);

      // Refresh table data
      await loadTableData(
        activeTableWindow.table.schema,
        activeTableWindow.table.name,
        { limit, offset }
      );
    } catch (error) {
      const msg = normalizeSqlError(error);
      setError(msg);
    }
  }, [
    limit,
    offset,
    activeProfileScreen,
    activeTableWindow,
    runtimeConnectionId,
    hasPatches,
    patchMap,
    engine,
    runSqlWithHistory,
    loadTableData,
    handleClearChanges,
  ]);

  const handleSaveChanges = useCallback(async () => {
    if (!activeTableWindow || !runtimeConnectionId) return;

    const promises = [];
    if (hasPatches) {
      promises.push(handleApplyPatches());
    }
    if (hasNewTableData) {
      promises.push(handleSaveNewTable());
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }, [
    activeTableWindow,
    runtimeConnectionId,
    handleApplyPatches,
    handleSaveNewTable,
    hasPatches,
    hasNewTableData,
  ]);

  const handleTableCreated = useCallback(
    async (tableName: string) => {
      await closeWindow(activeTableWindow!.id);

      // Refresh metadata to include the new table
      await refreshSchemaAndTables();

      // Open the newly created table
      await openTable({
        schema: activeSchema,
        name: tableName,
      });
    },
    [
      activeTableWindow,
      activeSchema,
      refreshSchemaAndTables,
      openTable,
      closeWindow,
    ]
  );

  useEffect(() => {
    if (activeTableData.structure && activeId && !tableStructureData?.length) {
      setTableStructure(
        activeProfileScreen,
        activeId,
        activeTableData.structure
      );
    }
  }, [activeTableData.structure, tableStructure, activeId, activeTableWindow]);

  useEffect(() => {
    if (
      activeTableData.constraints &&
      activeId &&
      !tableConstraintsData?.length
    ) {
      setTableConstraints(
        activeProfileScreen,
        activeId,
        activeTableData.constraints
      );
    }
  }, [
    activeTableData.constraints,
    tableConstraints,
    activeId,
    activeTableWindow,
  ]);

  /* =========================
   * Keyboard shortcuts
   * ========================= */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Detect platform: Mac uses metaKey, Windows/Linux use ctrlKey
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;

      // Only handle if modifier key is pressed
      if (!mod) return;

      // Don't handle if user is typing in an input field (unless it's a specific case)
      const target = e.target as HTMLElement;
      if (
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable
      ) {
        // Allow Ctrl+S in input fields to save changes
        if (e.key.toLowerCase() === "s") {
          e.preventDefault();
          e.stopPropagation();
          handleSaveChanges();
          return;
        }
        // For other shortcuts, ignore if in input field
        return;
      }

      const key = e.key.toLowerCase();

      // Cmd/Ctrl + T: Open new SQL editor window
      if (key === "t") {
        e.preventDefault();
        e.stopPropagation();
        handleOpenSqlEditor();
        return;
      }

      // Cmd/Ctrl + S: Save all changes
      if (key === "s") {
        e.preventDefault();
        e.stopPropagation();
        handleSaveChanges();
        return;
      }

      // Cmd/Ctrl + R: Refresh data
      if (key === "r") {
        e.preventDefault();
        e.stopPropagation();
        handleRefresh();
        return;
      }

      // Cmd/Ctrl + W: Close active window or connection tab
      if (key === "w") {
        e.preventDefault();
        e.stopPropagation();
        // If there's an active window, close it
        if (activeId) {
          // Create a synthetic mouse event for handleCloseWindow
          const syntheticEvent = new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
          }) as unknown as MouseEvent;
          handleCloseWindow(activeId, syntheticEvent);
        } else if (activeProfileScreen && activeProfileScreen !== "main") {
          // If no active window but there's an active connection tab, close the tab
          handleCloseConnectionTab(activeProfileScreen);
        }
        // Always prevent default to stop app/window from closing
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [
    handleOpenSqlEditor,
    handleSaveChanges,
    handleRefresh,
    handleCloseWindow,
    handleCloseConnectionTab,
    activeId,
    activeProfileScreen,
  ]);

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
   * Render helpers
   * ========================= */
  const renderMainContent = useCallback(() => {
    const contentArea = (
      <div class="transition-smooth flex flex-1 flex-col overflow-hidden">
        {activeWindows.length > 0 && (
          <div
            class={cn(
              "flex shrink-0 items-end overflow-x-auto overflow-y-hidden pt-1"
            )}
          >
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
            activeProfileScreen={activeProfileScreen}
            activeWindow={activeWindow}
            activeSchema={activeSchema}
            engine={engine || "postgres"}
            activeSqlWindow={activeSqlWindow}
            activeTableWindow={activeTableWindow}
            activeTableData={activeTableData}
            tableStructure={tableStructureData}
            tableConstraints={tableConstraintsData}
            setTableStructure={setTableStructure}
            setTableConstraints={setTableConstraints}
            limit={limit}
            offset={offset}
            totalRows={activeTableData.data?.rowCount ?? 0}
            loadError={loadError}
            hasAnyWindow={hasAnyWindow}
            onNewSql={handleOpenSqlEditor}
            onDataChange={handleDataChange}
            runtimeConnectionId={runtimeConnectionId}
            onRunSql={runSqlWithHistory}
            patchMap={patchMap}
            metadata={metadata}
            metaKey={metaKey}
            onPageChange={handlePageChange}
            onTableCreated={handleTableCreated}
            newTableSaveRef={newTableSaveRef}
          />
        </div>
      </div>
    );

    if (viewMode.includes("bottom")) {
      return (
        <SplitPane
          direction="vertical"
          initialRatio={0.7}
          minFirstPx={200}
          minSecondPx={150}
          splitterPx={2}
          first={contentArea}
          second={
            <div class="h-full overflow-hidden border-t border-neutral-200">
              <QueryHistory
                queries={sqlHistory}
                onClear={() => clearHistory(activeProfileScreen)}
              />
            </div>
          }
        />
      );
    }

    return contentArea;
  }, [
    activeWindows,
    activeWindow,
    activeSqlWindow,
    activeTableWindow,
    activeTableData,
    limit,
    offset,
    viewMode,
    selectWindow,
    activeId,
    handleCloseWindow,
    handleOpenSqlEditor,
    runtimeConnectionId,
    runSqlWithHistory,
    metadata,
    metaKey,
    handlePageChange,
    loadError,
    hasAnyWindow,
    engine,
    newTableSaveRef,
    activeProfileScreen,
    tableStructureData,
    tableConstraintsData,
    setTableStructure,
    setTableConstraints,
    handleDataChange,
    handleTableCreated,
  ]);

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
        canSaveChanges={hasPatches || hasNewTableData}
        handleSaveChanges={handleSaveChanges}
      />

      <div class="flex h-full flex-1 overflow-hidden">
        {viewMode.includes("left") ? (
          <SplitPane
            direction="horizontal"
            initialRatio={0.15}
            minFirstPx={200}
            minSecondPx={300}
            splitterPx={2}
            first={
              <div class="h-full overflow-hidden">
                <LeftNav
                  schemas={schemasForEditor}
                  handleOpenNewTable={openTable}
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
              </div>
            }
            second={
              <div class="flex h-full flex-1 flex-col overflow-hidden bg-neutral-100">
                {viewMode.includes("right") ? (
                  <SplitPane
                    direction="horizontal"
                    initialRatio={0.75}
                    minFirstPx={300}
                    minSecondPx={200}
                    splitterPx={2}
                    first={renderMainContent()}
                    second={
                      <div class="h-full overflow-hidden border-l border-neutral-200">
                        <RightNav sizeInfo={activeTableData.sizeInfo} />
                      </div>
                    }
                  />
                ) : (
                  renderMainContent()
                )}
              </div>
            }
          />
        ) : (
          <div class="flex h-full flex-1 overflow-hidden bg-neutral-100">
            {viewMode.includes("right") ? (
              <SplitPane
                direction="horizontal"
                initialRatio={0.75}
                minFirstPx={300}
                minSecondPx={200}
                splitterPx={2}
                first={renderMainContent()}
                second={
                  <div class="h-full overflow-hidden border-l border-neutral-200">
                    <RightNav sizeInfo={activeTableData.sizeInfo} />
                  </div>
                }
              />
            ) : (
              renderMainContent()
            )}
          </div>
        )}
      </div>

      <WarningRefreshDialog
        open={warningRefresh}
        onClose={() => {
          setWarningRefresh(false);
          setPendingCloseTabId(null);
        }}
        onDiscard={handleDiscardChanges}
      />

      {error && (
        <ErrorDialog
          open={!!error}
          error={error}
          onClose={() => setError(null)}
        />
      )}
    </div>
  );
}
