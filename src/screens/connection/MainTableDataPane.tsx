import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { TableData } from "src/components/table/TableData";
import { TableFilterBar } from "src/components/table/TableFilterBar";
import { TableFooter } from "src/components/table/TableFooter";
import { TableStructurePane } from "src/components/table/TableStructurePane";
import { LoadingTableState } from "./LoadingTableState";
import { ErrorState } from "./ErrorState";

import { DATA_KEYS, DEFAULT_FILTER_STATE } from "src/constant";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { useTableDataOperations } from "src/screens/connection/hooks/useTableDataOperations";
import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { TableViewMode } from "src/components/table/TableViewToggle";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { useTableFilter } from "src/components/table/tableHooks";
import { ExportTableDialog } from "src/components/modal/ExportTableDialog";
import { ImportTableDialog } from "src/components/modal/ImportTableDialog";
import { CloneTableDialog } from "src/components/modal/CloneTableDialog";
import { useImportTableData } from "src/hooks/useImportTableData";
import { TruncateTableDialog } from "src/components/modal/TruncateTableDialog";
import { DropTableDialog } from "src/components/modal/DropTableDialog";
import { SqlPreviewModal } from "src/components/modal/SqlPreviewModal";
import {
  cloneTableQuery,
  copyTableDataQuery,
  truncateTableQuery,
  dropTableQuery,
} from "src/hooks/queries";
import { TableForeignKey } from "src/types";

/* =============================================================================
 * Patch helpers
 * ============================================================================= */

export type StructPaneTab = "columns" | "constraints" | "foreignKeys";

type RowPatch = Record<string, any>;
type WindowPatches = Partial<
  Record<DataAction, Partial<Record<DataKey, Record<string, RowPatch>>>>
>;
type ActiveTableWindow = {
  id: string;
  table: { schema: string; name: string };
};

const EMPTY_META = {
  columns: null,
  structure: null,
  constraints: null,
  foreignKeys: null,
  sizeInfo: null,
  rowCount: null,
  busy: false,
  error: null,
};

const EMPTY_ARRAY: any[] = [];
const EMPTY_SET = new Set<number>();

function extractPatches(patches: WindowPatches | null) {
  if (!patches) return null;
  const res: Record<string, any> = {};
  Object.assign(res, patches.update?.data, patches.create?.data);
  return Object.keys(res).length ? res : null;
}

function extractDeleted(patches: WindowPatches | null, key: DataKey) {
  if (!patches) return EMPTY_SET;
  const map = patches.delete?.[key] ?? {};
  const out = new Set<number>();
  for (const k of Object.keys(map)) {
    const i = Number(k);
    if (!Number.isNaN(i)) out.add(i);
  }
  return out;
}

/* =============================================================================
 * Component
 * ============================================================================= */

export function MainTableDataPane(props: {
  activeTableWindow: ActiveTableWindow;
  isProfileLocked?: boolean;

  // pagination from outer layer (actions ctx)
  pageChange: (limit: number, offset: number) => void;

  // ✅ wire real actions (no stubs)
  onAddColumn: () => void;
  onDeleteColumn: (rowIndex: number) => void;
  onAddIndex: () => void;
  onDeleteIndex: (rowIndex: number) => void;
}) {
  const {
    activeTableWindow,
    isProfileLocked = false,
    pageChange,
    onAddColumn,
    onDeleteColumn,
    onAddIndex,
    onDeleteIndex,
  } = props;

  const rt = useConnectionRuntimeCtx();
  const actions = useConnectionActionsCtx();
  const s = useConnectionStore.getState();
  const { profileId, engine, limit, offset } = rt;

  const { loadTableData } = useLoadTableData();
  const {
    dataPreview: dataImportPreview,
    error: importError,
    importing: importBusy,
    importProgress: importProgressState,
    runImport,
    reset: resetImport,
    loadDataImport,
  } = useImportTableData();

  const [viewMode, setViewMode] = useState<TableViewMode>("data");
  const [structPaneTab, setStructPaneTab] = useState<StructPaneTab>("columns");
  const [, forceUpdate] = useState(0);
  const [sqlPreview, setSqlPreview] = useState("");
  const [sqlDialogOpen, setSqlDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [truncateDialogOpen, setTruncateDialogOpen] = useState(false);
  const [dropDialogOpen, setDropDialogOpen] = useState(false);

  const rerender = () => forceUpdate((n) => n + 1);

  const startedRef = useRef<string | null>(null);

  const activeKey = useMemo(
    () =>
      tableKey(
        profileId,
        activeTableWindow.table.schema,
        activeTableWindow.table.name
      ),
    [profileId, activeTableWindow]
  );

  const {
    filterBarVisible,
    filters,
    filterCombine,
    appliedFilters,
    appliedFilterCombine,
    setFilters,
    setFilterCombine,
    setFilterBarVisible,
    handleApplyFilters,
    handleClearFilters,
  } = useTableFilter(startedRef, activeKey);

  /* ===========================================================================
   * Subscribe minimal state
   * =========================================================================== */

  const handleLoadRows = useCallback(async () => {
    const effectiveKey = `${activeKey}:${limit}:${offset}:${appliedFilters.length}:${appliedFilterCombine}`;
    if (startedRef.current === effectiveKey) return;
    startedRef.current = effectiveKey;

    useConnectionStore.getState().initRows(activeKey, 5000);

    // Always refetch when filter state changes so cache matches current filters.
    // (If we had filters and then cleared, cache would still hold filtered rows.)
    await loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset },
      {
        force: true,
        refreshRows: true,
        refreshMeta: false,
        refreshStats: false,
        filters: appliedFilters.length ? appliedFilters : undefined,
        filterCombine: appliedFilterCombine,
      }
    );
  }, [
    activeTableWindow,
    activeKey,
    limit,
    offset,
    appliedFilters,
    appliedFilterCombine,
  ]);

  useEffect(() => {
    if (!activeKey) return;

    handleLoadRows();

    let last = "";

    const unsub = useConnectionStore.subscribe((s) => {
      const meta = s.tableDataMap[activeKey];
      const rows = s.getRowsWindowInfo(activeKey);
      const sig = JSON.stringify([
        meta?.error,
        meta?.columns?.length,
        meta?.rowCount,
        rows?.version,
        rows?.running,
        rows?.loadedMax,
        rows?.streamOffset,
      ]);

      if (sig !== last) {
        last = sig;
        rerender();
      }
    });

    return unsub;
  }, [activeKey, handleLoadRows]);

  /* ===========================================================================
   * Snapshots
   * =========================================================================== */

  const meta =
    useConnectionStore.getState().tableDataMap[activeKey] ?? EMPTY_META;
  const rowsInfo =
    useConnectionStore.getState().getRowsWindowInfo(activeKey) ?? null;

  const patches =
    useConnectionStore.getState().dataPatchMap[profileId]?.[
      activeTableWindow.id
    ]?.patches ?? null;

  const hasError = !!(meta.error || rowsInfo?.error);
  const errorText = String(meta.error || rowsInfo?.error || "");

  // Lazy-load structure/constraints when switching to Structure view.
  useEffect(() => {
    if (viewMode !== "structure") return;
    if (!activeTableWindow) return;
    if (meta.busy) return;

    const hasStructure =
      Array.isArray(meta.structure) && meta.structure.length > 0;
    const hasConstraints =
      Array.isArray(meta.constraints) && meta.constraints.length > 0;

    if (hasStructure && hasConstraints) return;

    void loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset },
      {
        refreshRows: false,
        refreshMeta: true,
        refreshStats: false,
      }
    );
  }, [
    viewMode,
    activeTableWindow,
    meta.busy,
    meta.structure,
    meta.constraints,
    loadTableData,
    limit,
    offset,
  ]);

  /* ===========================================================================
   * Row state
   * =========================================================================== */

  const rowsRunning = !!rowsInfo?.running;
  const streamOffset = rowsInfo?.streamOffset ?? 0;
  const loadedMax = rowsInfo?.loadedMax ?? -1;

  const hasAnyRowData = useMemo(() => {
    if (loadedMax >= streamOffset) return true;
    const base = rowsInfo?.base ?? 0;
    for (let i = 0; i < 5; i++) {
      if (useConnectionStore.getState().getRowAt(activeKey, base + i))
        return true;
    }
    return false;
  }, [loadedMax, streamOffset, activeKey]);

  const rowsKnownEmpty = !!rowsInfo && !rowsRunning && loadedMax < streamOffset;

  const shouldShowLoading =
    !hasError && !hasAnyRowData && !rowsKnownEmpty && rowsRunning;

  /* ===========================================================================
   * Mutations
   * =========================================================================== */

  const onDataChange = useCallback(
    (
      action: DataAction,
      dataKey: DataKey,
      rowIndex: number,
      data: Record<string, any>
    ) => {
      if (isProfileLocked) return;
      const rowKey =
        rowIndex === -1 && data.__rowKey
          ? String(data.__rowKey)
          : String(rowIndex);

      // Update patches for UI consistency (but not for creates, since they're handled by store)
      useConnectionStore.getState().setDataPatchMap(profileId, {
        dataKey,
        action,
        tableData: meta,
        tableWindow: activeTableWindow as any,
        rowKey,
        data,
      });

      // Convert row key to number
      const rowIdx = Number(rowKey);

      // Update existing row
      const existingRow = useConnectionStore
        .getState()
        .getRowAt(activeKey, rowIdx);
      if (!existingRow) return;

      // Create updated row by copying existing data and updating the changed column
      const updatedRow = [...existingRow];
      const columns = meta.columns ?? [];

      // Find the column that was changed and update it
      for (const [colName, newValue] of Object.entries(data)) {
        if (colName === "__rowKey") continue; // Skip internal row key

        const colIndex = columns.findIndex((col) => col.name === colName);
        if (colIndex >= 0) {
          updatedRow[colIndex] = newValue;
        }
      }

      // Update the row in the store
      useConnectionStore.getState().updateRow(activeKey, rowIdx, updatedRow);
    },
    [isProfileLocked, profileId, meta, activeTableWindow, activeKey]
  );

  const { handleAddRow, handleDeleteRow } = useTableDataOperations({
    activeKey,
    profileId,
    activeTableWindowId: activeTableWindow.id,
    isLocked: isProfileLocked,
    onDataChange,
  });

  /* ===========================================================================
   * Render guards
   * =========================================================================== */

  if (hasError) return <ErrorState message={errorText} />;
  if (shouldShowLoading) return <LoadingTableState />;

  /* ===========================================================================
   * Paging
   * =========================================================================== */

  const basePageTotal = useMemo(() => {
    if (typeof meta.rowCount === "number") {
      return Math.min(limit, Math.max(0, meta.rowCount - offset));
    }
    return limit;
  }, [meta.rowCount, limit, offset]);

  const pageTotal = useMemo(() => {
    if (!rowsInfo) return 0;

    const storeRows =
      rowsInfo.loadedMax >= rowsInfo.streamOffset
        ? rowsInfo.loadedMax - rowsInfo.streamOffset + 1
        : 0;

    return Math.max(basePageTotal, storeRows);
  }, [rowsInfo, basePageTotal]);

  const totalRows = useMemo(() => {
    if (typeof rowsInfo?.loadedMax !== "number" || rowsInfo.loadedMax < 0) {
      return 0;
    }

    return typeof meta.rowCount === "number"
      ? meta.rowCount
      : offset + pageTotal;
  }, [meta.rowCount, rowsInfo?.loadedMax, pageTotal, offset]);

  const getRowAt = (i: number) =>
    useConnectionStore.getState().getRowAt(activeKey, offset + i);

  const foreignKeyMap = useMemo(() => {
    const out: Record<string, TableForeignKey> = {};
    const fks = meta.foreignKeys ?? [];
    for (const fk of fks) {
      if (!fk.column_names || !fk.ref_column_names) continue;
      out[fk.column_names] = {
        schema: fk.ref_table_schema,
        table: fk.ref_table_name,
        column: fk.ref_column_names,
      };
    }
    return out;
  }, [meta.foreignKeys, activeTableWindow.table.schema]);

  const handleNavigateFk = useCallback(
    async (args: {
      value: string;
      refSchema: string;
      refTable: string;
      refColumn: string;
    }) => {
      const { value, refSchema, refTable, refColumn } = args;
      const refKey = tableKey(profileId, refSchema, refTable);
      const newFilters = [
        { id: 0, column: refColumn, operator: "=", value, enabled: true },
      ] as const;

      await actions.selectTable({ schema: refSchema, name: refTable });

      const s = useConnectionStore.getState();
      const currentFilter = s.tableFilterByKey[refKey] ?? DEFAULT_FILTER_STATE;

      s.setTableFilter(refKey, {
        ...currentFilter,
        filterBarVisible: true,
        filters: [...newFilters],
        filterCombine: "AND",
        appliedFilters: [...newFilters],
        appliedFilterCombine: "AND",
      });

      // Allow row load effect to run even when navigating within the same table.
      startedRef.current = null;
    },
    [actions, profileId]
  );

  const reloadTableData = useCallback(
    async (schema: string, name: string) => {
      startedRef.current = null;

      await loadTableData(
        schema,
        name,
        { limit, offset },
        {
          force: true,
          refreshRows: true,
          refreshMeta: false,
          refreshStats: false,
        }
      );
    },
    [limit, offset, loadTableData]
  );

  /* ===========================================================================
   * Export / Import / Clone / Truncate / Drop
   * =========================================================================== */

  const onExportOpen = useCallback(() => {
    setExportDialogOpen(true);
  }, [setExportDialogOpen]);

  const onImportOpen = useCallback(async () => {
    if (isProfileLocked) return;
    const loaded = await loadDataImport();
    if (!loaded) return;
    setImportDialogOpen(true);
  }, [isProfileLocked, loadDataImport, setImportDialogOpen]);

  const onImportClose = useCallback(() => {
    resetImport();
    setImportDialogOpen(false);
  }, [resetImport, setImportDialogOpen]);

  const onCloneOpen = useCallback(() => {
    if (isProfileLocked) return;
    setCloneDialogOpen(true);
  }, [isProfileLocked]);
  const onCloneClose = useCallback(() => setCloneDialogOpen(false), []);

  const onTruncateOpen = useCallback(() => {
    if (isProfileLocked) return;
    setTruncateDialogOpen(true);
  }, [isProfileLocked]);
  const onTruncateClose = useCallback(() => setTruncateDialogOpen(false), []);

  const onDropOpen = useCallback(() => {
    if (isProfileLocked) return;
    setDropDialogOpen(true);
  }, [isProfileLocked]);
  const onDropClose = useCallback(() => setDropDialogOpen(false), []);

  const handleTruncate = useCallback(
    async (opts: { restartIdentity: boolean; cascade: boolean }) => {
      if (isProfileLocked) return;
      if (!meta.connectionId) throw new Error("Not connected.");

      const { schema, name } = activeTableWindow.table;
      const sql = truncateTableQuery(schema, name, opts);
      await rt.runSqlWithHistory({
        windowId: activeTableWindow.id,
        connectionId: meta.connectionId,
        sql,
      });
      await reloadTableData(schema, name);
    },
    [
      isProfileLocked,
      meta.connectionId,
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      activeTableWindow.id,
      rt.runSqlWithHistory,
      reloadTableData,
    ]
  );

  const handleDrop = useCallback(async () => {
    if (isProfileLocked) return;
    if (!meta.connectionId) throw new Error("Not connected.");

    const { schema, name } = activeTableWindow.table;
    const sql = dropTableQuery(schema, name);
    await rt.runSqlWithHistory({
      windowId: activeTableWindow.id,
      connectionId: meta.connectionId,
      sql,
    });
    await rt.refreshSchemaAndTables();
    await actions.closeWindow(activeTableWindow.id, new MouseEvent("click"));
  }, [
    isProfileLocked,
    meta.connectionId,
    activeTableWindow.table.schema,
    activeTableWindow.table.name,
    activeTableWindow.id,
    rt.runSqlWithHistory,
    rt.refreshSchemaAndTables,
    actions.closeWindow,
  ]);

  const handleClone = useCallback(
    async (newTableName: string, copyData: boolean) => {
      if (isProfileLocked) return;
      if (!meta.connectionId) throw new Error("Not connected.");
      const { schema, name } = activeTableWindow.table;
      const createSql = cloneTableQuery(schema, name, newTableName);
      await rt.runSqlWithHistory({
        windowId: activeTableWindow.id,
        connectionId: meta.connectionId,
        sql: createSql,
      });
      if (copyData) {
        const insertSql = copyTableDataQuery(schema, name, newTableName);
        await rt.runSqlWithHistory({
          windowId: activeTableWindow.id,
          connectionId: meta.connectionId,
          sql: insertSql,
        });
      }
      await rt.refreshSchemaAndTables();
    },
    [
      isProfileLocked,
      meta.connectionId,
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      activeTableWindow.id,
      rt.runSqlWithHistory,
      rt.refreshSchemaAndTables,
    ]
  );

  const handleImport = useCallback(
    async (firstIsHeaders: boolean) => {
      if (isProfileLocked) return;
      const { schema, name } = activeTableWindow.table;
      runImport({
        connectionId: meta.connectionId,
        schema,
        tableName: name,
        columns: meta.columns ?? [],
        limit,
        offset,
        firstIsHeaders,
        onSuccess: async () => reloadTableData(schema, name),
      });
    },
    [
      isProfileLocked,
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      meta.connectionId,
      meta.columns,
      limit,
      offset,
      reloadTableData,
      runImport,
    ]
  );

  // When user chose Export/Import/Clone/Truncate/Drop from table context menu in left nav
  useEffect(() => {
    if (!rt.pendingTableAction) return;
    if (isProfileLocked) {
      rt.setPendingTableAction(null);
      return;
    }
    const action = rt.pendingTableAction;
    const t = setTimeout(() => {
      if (action === "export") onExportOpen();
      else if (action === "import") onImportOpen();
      else if (action === "clone") onCloneOpen();
      else if (action === "truncate") onTruncateOpen();
      else if (action === "drop") onDropOpen();
      rt.setPendingTableAction(null);
    }, 80);
    return () => clearTimeout(t);
  }, [
    isProfileLocked,
    rt.pendingTableAction,
    rt.setPendingTableAction,
    onExportOpen,
    onImportOpen,
    onCloneOpen,
    onTruncateOpen,
    onDropOpen,
  ]);

  /* ===========================================================================
   * Render
   * =========================================================================== */

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="min-h-0 flex-1 overflow-hidden">
        {viewMode === "structure" ? (
          <TableStructurePane
            engine={engine}
            profileId={profileId}
            readOnly={isProfileLocked}
            activeTableWindow={activeTableWindow as any}
            activeTableMeta={meta}
            structPaneTab={structPaneTab}
            setStructPaneTab={setStructPaneTab}
            tableStructure={
              s.tableStructure[profileId]?.[activeTableWindow.id] ?? EMPTY_ARRAY
            }
            tableConstraints={
              s.tableConstraints[profileId]?.[activeTableWindow.id] ??
              EMPTY_ARRAY
            }
            tableList={rt.metadata.get({ metaKey: rt.metaKey }).tables}
            onDataChange={onDataChange}
            onAddNewColumn={onAddColumn}
            onDeleteColumn={onDeleteColumn}
            deletedStructureRows={extractDeleted(patches, DATA_KEYS.structure)}
            onAddIndex={onAddIndex}
            onDeleteIndex={onDeleteIndex}
            deletedConstraintRows={extractDeleted(
              patches,
              DATA_KEYS.constraints
            )}
          />
        ) : (
          <>
            {filterBarVisible && (
              <TableFilterBar
                tableKey={activeKey}
                schema={activeTableWindow.table.schema}
                tableName={activeTableWindow.table.name}
                columns={meta.columns ?? []}
                filters={filters}
                filterCombine={filterCombine}
                appliedFilters={appliedFilters}
                limit={limit}
                offset={offset}
                setFilterVisible={setFilterBarVisible}
                onFiltersChange={setFilters}
                onFilterCombineChange={setFilterCombine}
                onApply={handleApplyFilters}
                onClear={handleClearFilters}
                onExport={onExportOpen}
                onImport={onImportOpen}
                onShowSql={(sql) => {
                  setSqlPreview(sql);
                  setSqlDialogOpen(true);
                }}
              />
            )}
            <TableData
              columns={meta.columns ?? []}
              baseRows={hasAnyRowData ? basePageTotal : 0}
              totalRows={hasAnyRowData ? pageTotal : 0}
              getRowAt={getRowAt}
              readOnly={isProfileLocked}
              onCellChange={isProfileLocked ? undefined : onDataChange}
              patches={extractPatches(patches)}
              onAddRow={() => {
                if (isProfileLocked) return;
                handleAddRow(meta.columns ?? [], pageTotal, onDataChange);
              }}
              onDeleteRow={(rowIndex) => {
                if (isProfileLocked) return;
                handleDeleteRow(rowIndex, offset);
              }}
              deletedRows={extractDeleted(patches, DATA_KEYS.data)}
              rowsVersion={rowsInfo?.version ?? 0}
              foreignKeyMap={foreignKeyMap}
              onNavigateFk={handleNavigateFk}
            />
          </>
        )}
      </div>

      <TableFooter
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        structPaneTab={structPaneTab}
        filterBarVisible={filterBarVisible}
        limit={limit}
        offset={offset}
        loadedMax={loadedMax}
        totalRows={totalRows}
        onPageChange={pageChange}
        onAddRow={() => {
          if (isProfileLocked) return;
          handleAddRow(meta.columns ?? [], pageTotal, onDataChange)
        }}
        onAddColumn={isProfileLocked ? () => {} : onAddColumn}
        onAddIndex={isProfileLocked ? () => {} : onAddIndex}
        onFilters={() => setFilterBarVisible((v) => !v, activeKey)}
        readOnly={isProfileLocked}
      />
      {sqlDialogOpen && (
        <SqlPreviewModal
          open={sqlDialogOpen}
          onClose={() => setSqlDialogOpen(false)}
          sqlPreview={sqlPreview}
        />
      )}

      {exportDialogOpen && (
        <ExportTableDialog
          open={exportDialogOpen}
          handleClose={() => setExportDialogOpen(false)}
          connectionId={meta.connectionId}
          schema={activeTableWindow.table.schema}
          tableName={activeTableWindow.table.name}
          columns={meta.columns ?? []}
          totalRows={totalRows}
          appliedFilters={appliedFilters}
          appliedFilterCombine={appliedFilterCombine}
        />
      )}

      {importDialogOpen && (
        <ImportTableDialog
          open={importDialogOpen}
          handleClose={onImportClose}
          schema={activeTableWindow.table.schema}
          tableName={activeTableWindow.table.name}
          columns={meta.columns ?? []}
          dataPreview={dataImportPreview}
          error={importError}
          importing={importBusy}
          progress={importProgressState}
          onImport={handleImport}
        />
      )}

      {cloneDialogOpen && (
        <CloneTableDialog
          open={cloneDialogOpen}
          onClose={onCloneClose}
          sourceTableName={activeTableWindow.table.name}
          onConfirm={handleClone}
        />
      )}

      {truncateDialogOpen && (
        <TruncateTableDialog
          open={truncateDialogOpen}
          onClose={onTruncateClose}
          tableName={activeTableWindow.table.name}
          onConfirm={handleTruncate}
        />
      )}

      {dropDialogOpen && (
        <DropTableDialog
          open={dropDialogOpen}
          onClose={onDropClose}
          tableName={activeTableWindow.table.name}
          onConfirm={handleDrop}
        />
      )}
    </div>
  );
}
