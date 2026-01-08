import { useState, useMemo, useCallback } from "preact/hooks";
import { useLoadTables } from "../../hooks/useLoadTables";
import { useLoadTableData } from "../../hooks/useLoadTableData";
import { useScreenStore } from "../../stores/screen";
import { Database } from "../../components/icons";
import { TableData } from "../../components/table/TableData";
import { connectionRemove } from "../../lib/tauri";
import { MenuBar } from "./MenuBar";
import { LeftNav } from "./LeftNav";
import { NavigationTabs } from "./NavigationTabs";
import { RightNav } from "./RightNav";
import { QueryHistory } from "./QueryHistory";
import { Box } from "../../components/common/Box";
import { cn } from "../../utils/cn";
import { TabViewMode, SqlQuery, OpenTable, TableItem } from "../../types";
import { useLoadSchemas } from "../../hooks/useLoadSchemas";

type PatchMap = {
  [tableId: string]: { [rowId: string]: { [column: string]: any } };
};

export function ConnectionScreen() {
  const {
    activeScreen,
    tabs,
    tabOpenTables,
    setTabOpenTables,
    activeTableId,
    setActiveTableId,
  } = useScreenStore();

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeScreen),
    [tabs, activeScreen]
  );
  const openTables = useMemo(
    () => tabOpenTables[activeScreen] || [],
    [tabOpenTables, activeScreen]
  );

  const [, setPatchMap] = useState<PatchMap>({});
  const [tableSearchQuery, setTableSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<TabViewMode[]>(["left"]);
  const [sqlHistory, setSqlHistory] = useState<SqlQuery[]>([]);
  const [activeSchema, setActiveSchema] = useState("public");
  const [expandedSections, setExpandedSections] = useState({
    functions: false,
    tables: true,
  });

  const {
    tables,
    busy: tableBusy,
    msg: tableMsg,
    loadTables,
  } = useLoadTables();

  const { schemas, msg: schemaMsg, busy: schemaBusy } = useLoadSchemas();

  const { loadTableData, getTableData, removeTableData } = useLoadTableData();

  // Filter tables by search query
  const filteredTables = useMemo(() => {
    if (!tableSearchQuery.trim()) return tables;
    const query = tableSearchQuery.toLowerCase();
    return tables.filter(
      (table) =>
        table.name.toLowerCase().includes(query) ||
        table.schema.toLowerCase().includes(query)
    );
  }, [tables, tableSearchQuery]);

  // Get active table
  const activeTable = useMemo(() => {
    return openTables.find((ot) => ot.id === activeTableId[activeScreen]);
  }, [tabOpenTables, activeTableId, activeScreen]);

  // Get table data for active table
  const activeTableData = useMemo(() => {
    if (!activeTable) {
      return { data: null, sizeInfo: null, busy: false, error: null };
    }
    return getTableData(activeTable.table.schema, activeTable.table.name);
  }, [activeTable, getTableData]);

  // Load table data when a table is selected
  const handleSelectTable = useCallback(
    async (table: TableItem) => {
      // Check if table is already open
      const existingTable = openTables.find(
        (ot) => ot.table.schema === table.schema && ot.table.name === table.name
      );

      if (existingTable) {
        // Switch to existing table
        setActiveTableId(activeScreen, `${table.schema}.${table.name}`);
      } else {
        // Open new table
        const newTable: OpenTable = {
          id: `${table.schema}.${table.name}`,
          table,
        };
        setTabOpenTables(activeScreen, [...(openTables || []), newTable]);
        setActiveTableId(activeScreen, newTable.id);

        await loadTableData(table.schema, table.name);
      }
    },
    [activeScreen, openTables, setTabOpenTables, loadTableData]
  );

  const handleCloseTable = useCallback(
    async (tableId: string, e: MouseEvent) => {
      e.stopPropagation();
      const tableToClose = openTables.find((ot) => ot.id === tableId);
      if (tableToClose) {
        const { schema, name } = tableToClose.table;
        const { connectionId } = getTableData(schema, name);
        removeTableData(schema, name);

        try {
          if (connectionId) {
            await connectionRemove(connectionId);
          }
        } catch (error) {
          console.error("Error removing connection:", error);
        }
      }

      const newOpenTables = openTables.filter((ot) => ot.id !== tableId);
      setTabOpenTables(activeScreen, newOpenTables);

      // If closing active table, switch to another or clear
      if (activeTableId[activeScreen] === tableId) {
        if (newOpenTables.length > 0) {
          setActiveTableId(
            activeScreen,
            newOpenTables[newOpenTables.length - 1].id
          );
        } else {
          setActiveTableId(activeScreen, null);
        }
      }
    },
    [
      activeTableId[activeScreen],
      openTables,
      setTabOpenTables,
      setActiveTableId,
    ]
  );

  const handleCellChange = useCallback(
    (rowIndex: number, columnIndex: number, value: any) => {
      setPatchMap((prev) => ({
        ...prev,
        [rowIndex]: {
          ...prev[rowIndex],
          [columnIndex]: value,
        },
      }));
    },
    []
  );

  const handleViewModeChange = useCallback(
    (mode: TabViewMode) => {
      setViewMode((prev) => {
        if (prev.includes(mode)) {
          return prev.filter((m) => m !== mode);
        }
        return [...prev, mode];
      });
    },
    [setViewMode]
  );

  const handleRefresh = useCallback(async () => {
    await loadTables(activeSchema);
    if (!activeTable) return;
    await loadTableData(activeTable.table.schema, activeTable.table.name);
  }, [activeTable, activeSchema, loadTables, loadTableData]);

  const handleSchemaChange = useCallback(
    async (schema: string) => {
      setActiveSchema(schema);
      await loadTables(schema);
    },
    [loadTables]
  );

  if (!activeTab) {
    return (
      <Box className="bg-neutral-100 text-center">
        <p class="text-neutral-500">No connection selected</p>
      </Box>
    );
  }

  if (
    (tableBusy && tables.length === 0) ||
    (schemaBusy && schemas.length === 0)
  ) {
    return (
      <Box className="bg-neutral-100 text-center">
        <p class="text-neutral-500">Connecting to {activeTab.label}...</p>
      </Box>
    );
  }

  const renderTableContent = useCallback(() => {
    if (!activeTable) {
      return (
        <Box>
          <p class="text-neutral-500">Select a table to view data</p>
        </Box>
      );
    }

    if (activeTableData.busy) {
      return (
        <Box className="text-center">
          <div class="mb-4 inline-block h-8 w-8 animate-spin rounded-full border-b-2 border-blue-600"></div>
          <p class="text-neutral-500">Loading table data...</p>
        </Box>
      );
    }

    if (activeTableData.error) {
      return (
        <Box className="text-center">
          <p class="mb-2 text-red-600">Error loading table data</p>
          <p class="text-sm text-neutral-500">{activeTableData.error}</p>
        </Box>
      );
    }

    if (activeTableData.data) {
      return (
        <TableData
          key={activeTable.id}
          columns={activeTableData.data.columns}
          data={activeTableData.data.rows}
          onCellChange={handleCellChange}
        />
      );
    }

    return null;
  }, [activeTable, activeTableData, handleCellChange]);

  return (
    <div class="flex h-full flex-1 flex-col">
      <MenuBar
        activeSchema={activeTable?.table.schema}
        activeTable={activeTable?.table.name}
        viewMode={viewMode}
        loadTableError={tableMsg || schemaMsg || activeTableData.error}
        onViewModeChange={handleViewModeChange}
        onRefresh={handleRefresh}
      />

      <div class="flex h-full flex-1 overflow-hidden">
        {viewMode.includes("left") && (
          <LeftNav
            schemas={schemas}
            currSchema={activeSchema}
            onSchemaChange={handleSchemaChange}
            tableSearchQuery={tableSearchQuery}
            setTableSearchQuery={setTableSearchQuery}
            expandedSections={expandedSections}
            setExpandedSections={setExpandedSections}
            filteredTables={filteredTables}
            handleSelectTable={handleSelectTable}
            activeTableId={activeTableId[activeScreen]}
          />
        )}

        <div
          class={cn(
            "transition-smooth flex flex-1 flex-col overflow-hidden bg-neutral-100",
            viewMode.includes("right") && "flex-row!"
          )}
        >
          <div class="transition-smooth flex flex-1 flex-col overflow-hidden">
            {openTables.length > 0 && (
              <div
                class={cn(
                  "flex shrink-0 items-center gap-0.5 overflow-x-auto pt-1 pb-0.5 transition-all duration-300 ease-in-out",
                  "[-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                )}
              >
                <NavigationTabs
                  openTables={openTables}
                  setActiveTableId={(id) => setActiveTableId(activeScreen, id)}
                  activeTableId={activeTableId[activeScreen]}
                  handleCloseTable={handleCloseTable}
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
              {tableMsg ? (
                <Box className="text-center">
                  <p class="text-sm text-red-500">{tableMsg}</p>
                </Box>
              ) : openTables.length > 0 ? (
                renderTableContent()
              ) : (
                <Box className="text-center">
                  <Database className="mx-auto mb-4 size-12 text-neutral-300" />
                  <p class="text-neutral-500">
                    Select a table from the sidebar to view data
                  </p>
                </Box>
              )}
            </div>

            {/* Bottom Tab: SQL History */}
            {viewMode.includes("bottom") && (
              <div class="animate-slide-in-up h-64 shrink-0 border-t border-neutral-200">
                <QueryHistory
                  queries={sqlHistory}
                  onClear={() => setSqlHistory([])}
                  onSelectQuery={(query) => {
                    // TODO: Handle query selection (e.g., open in SQL editor)
                    console.log("Selected query:", query);
                  }}
                />
              </div>
            )}
          </div>

          {/* Right Tab: Table Size */}
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
