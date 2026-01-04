import { useState, useMemo } from "preact/hooks";
import { useLoadTables, type TableItem } from "../hooks/useLoadTables";
import { useLoadTableData } from "../hooks/useLoadTableData";
import { useScreenStore } from "../stores/screen";
import {
  ChevronDown,
  ChevronRight,
  Database,
  Search,
  Table,
  X,
} from "../components/icons";
import { EditableTable } from "../components/EditableTable";
import { cn } from "../utils/cn";
import { Button } from "../components/common/Button";

type OpenTable = {
  id: string;
  table: TableItem;
};

export function ConnectionScreen() {
  const { activeScreen, tabs } = useScreenStore();
  const activeTab = tabs.find((tab) => tab.id === activeScreen);
  const [tableSearchQuery, setTableSearchQuery] = useState("");
  const [openTables, setOpenTables] = useState<OpenTable[]>([]);
  const [activeTableId, setActiveTableId] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState({
    functions: false,
    tables: true,
  });

  const { tables, busy } = useLoadTables();
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
    return openTables.find((ot) => ot.id === activeTableId);
  }, [openTables, activeTableId]);

  // Get table data for active table
  const activeTableData = useMemo(() => {
    if (!activeTable) return { data: null, busy: false, error: null };
    return getTableData(activeTable.table.schema, activeTable.table.name);
  }, [activeTable, getTableData]);

  // Load table data when a table is selected
  const handleSelectTable = async (table: TableItem) => {
    // Check if table is already open
    const existingTable = openTables.find(
      (ot) => ot.table.schema === table.schema && ot.table.name === table.name
    );

    if (existingTable) {
      // Switch to existing table
      setActiveTableId(`${table.schema}.${table.name}`);
    } else {
      // Open new table
      const newTable: OpenTable = {
        id: `${table.schema}.${table.name}`,
        table,
      };
      setOpenTables([...openTables, newTable]);
      setActiveTableId(newTable.id);

      await loadTableData(table.schema, table.name);
    }
  };

  // Close a table
  const handleCloseTable = (tableId: string, e: MouseEvent) => {
    e.stopPropagation();
    const tableToClose = openTables.find((ot) => ot.id === tableId);
    if (tableToClose) {
      removeTableData(tableToClose.table.schema, tableToClose.table.name);
    }

    const newOpenTables = openTables.filter((ot) => ot.id !== tableId);
    setOpenTables(newOpenTables);

    // If closing active table, switch to another or clear
    if (activeTableId === tableId) {
      if (newOpenTables.length > 0) {
        setActiveTableId(newOpenTables[newOpenTables.length - 1].id);
      } else {
        setActiveTableId(null);
      }
    }
  };

  if (!activeTab) {
    return (
      <div class="h-full flex items-center justify-center bg-neutral-100">
        <div class="text-center">
          <p class="text-neutral-500">No connection selected</p>
        </div>
      </div>
    );
  }

  if (busy && tables.length === 0) {
    return (
      <div class="h-full flex items-center justify-center bg-neutral-100">
        <div class="text-center">
          <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
          <p class="text-neutral-500">Connecting to {activeTab.label}...</p>
        </div>
      </div>
    );
  }

  return (
    <div class="h-full flex-1 flex">
      {/* Left Sidebar */}
      <div class="w-64 h-full bg-neutral-100 flex flex-col shrink-0 pt-1">
        {/* Search Bar */}
        <div class="px-2 py-1 border-b border-neutral-100">
          <div class="relative">
            <input
              type="text"
              placeholder="Search for item..."
              value={tableSearchQuery}
              onInput={(e: any) => setTableSearchQuery(e.currentTarget.value)}
              class="w-full pl-8 pr-8 py-1 text-xs rounded-md bg-neutral-50 border border-neutral-200 text-neutral-700 placeholder:text-neutral-500 focus:outline-none"
            />
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-neutral-500" />
          </div>
        </div>

        {/* Collapsible Sections */}
        <div class="flex-1 overflow-y-auto p-2">
          {/* Functions Section */}
          <Button
            variant="ghost"
            onClick={() =>
              setExpandedSections((prev) => ({
                ...prev,
                functions: !prev.functions,
              }))
            }
            className="w-full justify-start px-2"
          >
            {expandedSections.functions ? (
              <ChevronDown className="size-3" />
            ) : (
              <ChevronRight className="size-3" />
            )}
            <span>Functions</span>
          </Button>

          {/* Tables Section */}
          <div class="mt-1">
            <Button
              variant="ghost"
              onClick={() =>
                setExpandedSections((prev) => ({
                  ...prev,
                  tables: !prev.tables,
                }))
              }
              className="w-full justify-start px-2"
            >
              {expandedSections.tables ? (
                <ChevronDown className="size-3" />
              ) : (
                <ChevronRight className="size-3" />
              )}
              <span>Tables</span>
            </Button>

            {expandedSections.tables && (
              <div class="mt-1 space-y-0.5 pl-4">
                {filteredTables.length === 0 ? (
                  <div class="px-3 py-2 text-xs text-neutral-500">
                    No tables found
                  </div>
                ) : (
                  filteredTables.map((table) => {
                    const key = `${table.schema}.${table.name}`;
                    return (
                      <Button
                        variant="ghost"
                        key={key}
                        onClick={() => handleSelectTable(table)}
                        active={activeTableId === key}
                        className="w-full px-3 py-1.5 rounded-md justify-start text-xs"
                      >
                        <Table className="size-4" />
                        {table.name}
                      </Button>
                    );
                  })
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Content Area */}
      <div class="flex-1 flex flex-col pt-1 bg-neutral-100 overflow-x-auto">
        {openTables.length > 0 ? (
          <>
            {/* Table Tabs */}
            <div class="flex items-center gap-0.5 border-b border-neutral-100 bg-neutral-100 overflow-x-auto [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none]">
              {openTables.map((openTable) => (
                <div
                  key={openTable.id}
                  onClick={() => setActiveTableId(openTable.id)}
                  class={`group flex items-center gap-2 px-2 py-1.5 rounded-t-md transition-colors cursor-pointer shrink-0 ${
                    activeTableId === openTable.id
                      ? "bg-white text-neutral-700"
                      : "text-neutral-600 bg-neutral-200 hover:bg-slate-200"
                  }`}
                >
                  <div class="flex items-center gap-2">
                    <Table className="size-4" />
                    <span
                      class={cn(
                        "text-xs",
                        activeTableId === openTable.id
                          ? "text-neutral-700 font-bold"
                          : "text-neutral-600"
                      )}
                    >
                      {openTable.table.name}
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={(e) => handleCloseTable(openTable.id, e)}
                    class={`opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-neutral-200 ${
                      activeTableId === openTable.id ? "opacity-100" : ""
                    }`}
                    title="Close table"
                  >
                    <X className="size-3.5 text-neutral-500" />
                  </button>
                </div>
              ))}
            </div>

            {/* Table Data */}
            {activeTable ? (
              <div class="flex-1 overflow-auto">
                {/* Table Header */}
                {/* <div class="px-4 py-3 border-b border-neutral-200 bg-neutral-50 sticky top-0 z-10">
                  <h2 class="text-lg font-semibold text-neutral-900">{activeTable.table.name}</h2>
                </div> */}

                {/* Table Content */}
                {activeTableData.busy ? (
                  <div class="flex items-center justify-center h-full bg-white">
                    <div class="text-center">
                      <div class="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mb-4"></div>
                      <p class="text-neutral-500">Loading table data...</p>
                    </div>
                  </div>
                ) : activeTableData.error ? (
                  <div class="flex items-center justify-center h-full">
                    <div class="text-center">
                      <p class="text-red-600 mb-2">Error loading table data</p>
                      <p class="text-sm text-neutral-500">
                        {activeTableData.error}
                      </p>
                    </div>
                  </div>
                ) : activeTableData.data ? (
                  <EditableTable
                    columns={activeTableData.data.columns}
                    data={activeTableData.data.rows}
                    onCellChange={(rowIndex, columnIndex, value) => {
                      // Handle cell value change
                      console.log(
                        "Cell changed:",
                        rowIndex,
                        columnIndex,
                        value
                      );
                      // TODO: Implement save to database
                    }}
                  />
                ) : null}
              </div>
            ) : (
              <div class="flex items-center justify-center h-full">
                <p class="text-neutral-500">Select a table to view data</p>
              </div>
            )}
          </>
        ) : (
          <div class="flex items-center justify-center h-full bg-white">
            <div class="text-center">
              <Database className="size-12 text-neutral-300 mx-auto mb-4" />
              <p class="text-neutral-500">
                Select a table from the sidebar to view data
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
