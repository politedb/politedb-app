import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { TableData } from "src/components/table/TableData";
import { commitTableCellEdit } from "src/components/table/commitTableCellEdit";
import { buildSelectedRowDetail } from "src/components/table/selectedRowDetail";
import {
  buildNewRowsFromPatches,
  useNewRows,
} from "src/components/table/tableHooks";
import { createTablePatchHelpers } from "src/screens/connection/hooks/useTablePatches";
import { EMPTY_OBJECT } from "src/components/table/tableUtils";
import { useTablePatches } from "src/screens/connection/hooks/useTablePatches";
import { TableFilterBar } from "src/components/table/TableFilterBar";
import { TableFooter } from "src/components/table/TableFooter";
import { TableStructurePane } from "src/components/table/TableStructurePane";
import { LoadingTableState } from "./LoadingTableState";

import { DATA_KEYS, DEFAULT_FILTER_STATE } from "src/constant";
import {
  DataAction,
  DataKey,
  type SelectedRowDetail,
  useConnectionStore,
} from "src/stores/connection";
import { useTableDataOperations } from "src/screens/connection/hooks/useTableDataOperations";
import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { TableViewMode } from "src/components/table/TableViewToggle";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import { useConnectionActionsCtx } from "./ConnectionActionsContext";
import { useTableFilter } from "src/components/table/tableHooks";
import { useImportTableData } from "src/hooks/useImportTableData";
import {
  cloneTableQuery,
  copyTableDataQuery,
  truncateTableQuery,
  dropTableQuery,
  type TableSort,
} from "src/lib/queries/sql";
import type { TableForeignKey, TableItem } from "src/types";
import { MainTableDialogs } from "./MainTableDialogs";
import { useMainTablePaneState } from "./hooks/useMainTablePaneState";
import { useMainTableDataLoading } from "./hooks/useMainTableDataLoading";

export type { StructPaneTab } from "./hooks/useMainTablePaneState";

/* =============================================================================
 * Patch helpers
 * ============================================================================= */

type RowPatch = Record<string, any>;
type WindowPatches = Partial<
  Record<DataAction, Partial<Record<DataKey, Record<string, RowPatch>>>>
>;
type ActiveTableWindow = {
  id: string;
  table: TableItem;
};
type ExportScope = "all" | "page";

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
  const isRedis = engine === "redis";
  const isNewTable = !!activeTableWindow.table.new;
  const isDataReadOnly = isProfileLocked;
  const isStructureReadOnly =
    isProfileLocked || engine === "mongo" || engine === "cassandra" || isRedis;
  const canAddDataRow = !isDataReadOnly && !isRedis;

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
  const [, forceUpdate] = useState(0);
  const [exportScope, setExportScope] = useState<ExportScope>("all");
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

  const sortState = useConnectionStore(
    (s) => s.tableSortByKey[activeKey] ?? null
  );
  const setTableSort = useConnectionStore((s) => s.setTableSort);

  const {
    structPaneTab,
    setStructPaneTab,
    sqlPreview,
    setSqlPreview,
    sqlDialogOpen,
    setSqlDialogOpen,
    importDialogOpen,
    setImportDialogOpen,
    exportDialogOpen,
    setExportDialogOpen,
    cloneDialogOpen,
    setCloneDialogOpen,
    truncateDialogOpen,
    setTruncateDialogOpen,
    dropDialogOpen,
    setDropDialogOpen,
    progressNow,
    setProgressNow,
    errorDialogOpen,
    setErrorDialogOpen,
    settledPagination,
    setSettledPagination,
  } = useMainTablePaneState({ limit, offset });

  const rerender = () => forceUpdate((n) => n + 1);

  const {
    filterBarVisible,
    filters,
    filterCombine,
    appliedFilters,
    appliedFilterCombine,
    filterApplySeq,
    setFilters,
    setFilterCombine,
    setFilterBarVisible,
    handleApplyFilters,
    handleClearFilters,
  } = useTableFilter(startedRef, activeKey);

  const applyFilters = useCallback(
    (
      newFilters: Parameters<typeof handleApplyFilters>[0],
      combine: Parameters<typeof handleApplyFilters>[1],
      tableKey: string
    ) => {
      if (offset !== 0) {
        pageChange(limit, 0);
        setSettledPagination({ limit, offset: 0 });
      }
      handleApplyFilters(newFilters, combine, tableKey);
    },
    [offset, limit, pageChange, handleApplyFilters]
  );

  const clearFilters = useCallback(
    (visible: boolean = true) => {
      if (offset !== 0) {
        pageChange(limit, 0);
        setSettledPagination({ limit, offset: 0 });
      }
      handleClearFilters(visible);
    },
    [offset, limit, pageChange, handleClearFilters]
  );

  const setSelectedRowDetail = useConnectionStore(
    (s) => s.setSelectedRowDetail
  );
  const clearSelectedRowDetail = useConnectionStore(
    (s) => s.clearSelectedRowDetail
  );
  const registerRowFieldEditHandler = useConnectionStore(
    (s) => s.registerRowFieldEditHandler
  );

  useEffect(() => {
    clearSelectedRowDetail(activeKey);
    setSettledPagination({ limit, offset });
  }, [activeKey, clearSelectedRowDetail]);

  const handleSelectedRowDetailChange = useCallback(
    (detail: SelectedRowDetail | null) => {
      setSelectedRowDetail(activeKey, detail);
    },
    [activeKey, setSelectedRowDetail]
  );

  const {
    meta,
    rowsInfo,
    hasError,
    errorText,
    hasAppliedFilters,
    basePageTotal,
    loadedMax,
    loadedRowCount,
    showingStalePage,
    renderLimit,
    renderOffset,
    shouldShowLoading,
    rowsLoadProgress,
    dismissCurrentError,
    clearLoadedQuerySignature,
  } = useMainTableDataLoading({
    activeKey,
    activeTableWindow,
    engine,
    limit,
    offset,
    startedRef,
    appliedFilters,
    appliedFilterCombine,
    filterApplySeq,
    sortState,
    settledPagination,
    setSettledPagination,
    progressNow,
    setProgressNow,
    viewMode: viewMode === "structure" ? "structure" : "data",
    setErrorDialogOpen,
    loadTableData,
    rerender,
  });

  const handleChangeSort = useCallback(
    (nextSort: TableSort | null) => {
      setTableSort(activeKey, nextSort);
      if (renderOffset !== 0) {
        pageChange(limit, 0);
      }
    },
    [activeKey, setTableSort, renderOffset, pageChange, limit]
  );

  const patches =
    useConnectionStore.getState().dataPatchMap[profileId]?.[
      activeTableWindow.id
    ]?.patches ?? null;
  const newRowKeys = useMemo(
    () => Object.keys((patches?.create?.data ?? {}) as Record<string, unknown>),
    [patches]
  );

  const dataPatches = useMemo(() => extractPatches(patches), [patches]);
  const deletedDataRows = useMemo(
    () => extractDeleted(patches, DATA_KEYS.data),
    [patches]
  );

  /* ===========================================================================
   * Row state
   * =========================================================================== */

  /* ===========================================================================
   * Mutations
   * =========================================================================== */

  const refreshSelectedRowDetailRef = useRef<
    ((pageRowIdx: number) => void) | null
  >(null);

  const onDataChange = useCallback(
    (
      action: DataAction,
      dataKey: DataKey,
      rowIndex: number,
      data: Record<string, any>
    ) => {
      if (isDataReadOnly) return;
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

      // Page-local row index in patches; global index in row store.
      const pageRowIdx = Number(rowKey);
      const globalRowIdx =
        rowIndex === -1
          ? -1
          : renderOffset + (Number.isNaN(pageRowIdx) ? rowIndex : pageRowIdx);

      if (globalRowIdx < 0) return;

      // Update existing row
      const existingRow = useConnectionStore
        .getState()
        .getRowAt(activeKey, globalRowIdx);
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
      useConnectionStore
        .getState()
        .updateRow(activeKey, globalRowIdx, updatedRow);

      if (dataKey === DATA_KEYS.data) {
        const parsedKey = Number(rowKey);
        const pageRowIdx =
          rowIndex === -1
            ? basePageTotal
            : Number.isNaN(parsedKey)
              ? rowIndex
              : parsedKey;
        refreshSelectedRowDetailRef.current?.(pageRowIdx);
      }
    },
    [
      isDataReadOnly,
      profileId,
      meta,
      activeTableWindow,
      activeKey,
      renderOffset,
      basePageTotal,
    ]
  );

  const { handleAddRow, handleDeleteRow } = useTableDataOperations({
    activeKey,
    profileId,
    activeTableWindowId: activeTableWindow.id,
    isLocked: isDataReadOnly,
    onDataChange,
  });

  const tableColumns = useMemo(() => {
    const defaultsByColumn = new Map(
      (meta.structure ?? []).map((col) => [
        col.column_name,
        col.column_default ?? null,
      ])
    );
    return (meta.columns ?? []).map((col) => ({
      ...col,
      column_default:
        col.column_default ?? defaultsByColumn.get(col.name) ?? null,
    }));
  }, [meta.columns, meta.structure]);
  const columnsKey = useMemo(
    () => tableColumns.map((col) => col.name).join("\0"),
    [tableColumns]
  );
  const columnDefaultsKey = useMemo(
    () =>
      tableColumns
        .map((col) => `${col.name}:${col.column_default ?? ""}`)
        .join("\0"),
    [tableColumns]
  );

  const patchHelpers = useTablePatches({
    patches: hasError ? null : dataPatches,
    newRowKeys: hasError ? [] : newRowKeys,
    deletedRows: hasError ? EMPTY_SET : deletedDataRows,
    editedDataLength: hasError ? 0 : basePageTotal,
  });

  const newRowsForDetail = useNewRows(
    hasError ? null : dataPatches,
    hasError ? [] : newRowKeys,
    tableColumns,
    columnsKey
  );

  const renderBasePageTotal = useMemo(() => {
    if (typeof meta.rowCount === "number") {
      return Math.min(renderLimit, Math.max(0, meta.rowCount - renderOffset));
    }
    return renderLimit;
  }, [meta.rowCount, renderLimit, renderOffset]);

  const rowFieldEditCtxRef = useRef({
    activeKey,
    tableColumns,
    patchHelpers,
    newRowsForDetail,
    hasError,
    basePageTotal: renderBasePageTotal,
    offset: renderOffset,
    rowsVersion: 0,
  });
  rowFieldEditCtxRef.current = {
    activeKey,
    tableColumns,
    patchHelpers,
    newRowsForDetail,
    hasError,
    basePageTotal: renderBasePageTotal,
    offset: renderOffset,
    rowsVersion: rowsInfo?.version ?? 0,
  };

  const onDataChangeRef = useRef(onDataChange);
  onDataChangeRef.current = onDataChange;

  const getRowArrayForDetail = useCallback(
    (idx: number): unknown[] | undefined => {
      const ctx = rowFieldEditCtxRef.current;
      if (ctx.hasError || idx < 0) return undefined;

      const totalLen = ctx.basePageTotal;
      if (idx < totalLen) {
        return useConnectionStore
          .getState()
          .getRowAt(ctx.activeKey, ctx.offset + idx);
      }

      const j = idx - totalLen;
      if (j >= 0 && j < ctx.newRowsForDetail.length) {
        const obj = ctx.newRowsForDetail[j]?.row ?? EMPTY_OBJECT;
        const out = new Array(ctx.tableColumns.length);
        for (let c = 0; c < ctx.tableColumns.length; c++) {
          const name = ctx.tableColumns[c]!.name;
          const cell = (obj as Record<string, { v?: unknown } | unknown>)?.[
            name
          ];
          out[c] =
            cell && typeof cell === "object" && cell !== null && "v" in cell
              ? (cell as { v?: unknown }).v
              : (cell ?? null);
        }
        return out;
      }

      return undefined;
    },
    []
  );

  refreshSelectedRowDetailRef.current = (pageRowIdx: number) => {
    const selected = useConnectionStore.getState().selectedRowByKey[activeKey];
    if (!selected || selected.rowIndex !== pageRowIdx) return;

    const windowPatches =
      useConnectionStore.getState().dataPatchMap[profileId]?.[
        activeTableWindow.id
      ]?.patches ?? null;
    const freshDataPatches = extractPatches(windowPatches);
    const freshNewRowKeys = Object.keys(
      (windowPatches?.create?.data ?? {}) as Record<string, unknown>
    );
    const freshDeleted = extractDeleted(windowPatches, DATA_KEYS.data);
    const freshPatchHelpers = createTablePatchHelpers({
      patches: freshDataPatches,
      newRowKeys: freshNewRowKeys,
      deletedRows: freshDeleted,
      editedDataLength: basePageTotal,
    });
    const freshNewRows = buildNewRowsFromPatches(
      freshDataPatches,
      freshNewRowKeys,
      tableColumns
    );

    setSelectedRowDetail(
      activeKey,
      buildSelectedRowDetail(
        pageRowIdx,
        tableColumns,
        getRowArrayForDetail,
        freshPatchHelpers,
        freshNewRows
      )
    );
  };

  useEffect(() => {
    const selected = useConnectionStore.getState().selectedRowByKey[activeKey];
    if (!selected) return;
    refreshSelectedRowDetailRef.current?.(selected.rowIndex);
  }, [activeKey, columnDefaultsKey]);

  useEffect(() => {
    if (isDataReadOnly || hasError || viewMode !== "data") {
      registerRowFieldEditHandler(activeKey, undefined);
      return;
    }

    const handler = (
      rowIndex: number,
      columnName: string,
      newValue: unknown
    ) => {
      const ctx = rowFieldEditCtxRef.current;
      const changed = commitTableCellEdit({
        rowIdx: rowIndex,
        columnName,
        newValue,
        columns: ctx.tableColumns,
        getRowArray: getRowArrayForDetail,
        patchHelpers: ctx.patchHelpers,
        newRows: ctx.newRowsForDetail,
        dataKey: DATA_KEYS.data,
        onCellChange: onDataChangeRef.current,
      });

      if (!changed) return;

      refreshSelectedRowDetailRef.current?.(rowIndex);
    };

    registerRowFieldEditHandler(activeKey, handler);
    return () => registerRowFieldEditHandler(activeKey, undefined);
  }, [
    activeKey,
    isDataReadOnly,
    hasError,
    viewMode,
    getRowArrayForDetail,
    registerRowFieldEditHandler,
    setSelectedRowDetail,
  ]);

  /* ===========================================================================
   * Render guards
   * =========================================================================== */

  if (shouldShowLoading)
    return <LoadingTableState progress={rowsLoadProgress} />;

  /* ===========================================================================
   * Paging
   * =========================================================================== */

  const pageTotal = useMemo(() => {
    if (!rowsInfo) return 0;

    if (hasAppliedFilters) {
      // When filters are applied, rowCount is the source of truth for the
      // filtered result size. loadedRowCount may still reflect stale rows from
      // a previous unfiltered window while new chunks are arriving.
      if (typeof meta.rowCount === "number") {
        return Math.min(Math.max(meta.rowCount, 0), loadedRowCount);
      }
      return loadedRowCount;
    }

    if (loadedRowCount <= 0) {
      return basePageTotal;
    }

    return Math.min(basePageTotal, loadedRowCount);
  }, [rowsInfo, hasAppliedFilters, basePageTotal, loadedRowCount]);

  const visiblePageTotal = showingStalePage ? renderBasePageTotal : pageTotal;

  const totalRows = useMemo(() => {
    if (typeof rowsInfo?.loadedMax !== "number" || rowsInfo.loadedMax < 0) {
      return 0;
    }

    return typeof meta.rowCount === "number"
      ? meta.rowCount
      : renderOffset + pageTotal;
  }, [meta.rowCount, rowsInfo?.loadedMax, pageTotal, renderOffset]);

  const footerTotalRows = useMemo(() => {
    if (hasAppliedFilters) {
      return typeof meta.rowCount === "number" ? meta.rowCount : loadedRowCount;
    }
    return totalRows;
  }, [hasAppliedFilters, meta.rowCount, loadedRowCount, totalRows]);

  const getRowAt = (i: number) =>
    useConnectionStore.getState().getRowAt(activeKey, renderOffset + i);

  const getEmptyRowAt = useCallback(() => undefined, []);

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

      // Force the destination table to reload with the new FK filter instead
      // of briefly reusing the previous query signature / stale rows.
      clearLoadedQuerySignature(refKey);

      // Allow row load effect to run even when navigating within the same table.
      startedRef.current = null;

      await actions.selectTable({ schema: refSchema, name: refTable });
    },
    [actions, profileId, clearLoadedQuerySignature]
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
          filters: appliedFilters.length ? appliedFilters : undefined,
          filterCombine: appliedFilterCombine,
          sortBy: sortState,
        }
      );
    },
    [
      limit,
      offset,
      loadTableData,
      appliedFilters,
      appliedFilterCombine,
      sortState,
    ]
  );

  const handleContextRefresh = useCallback(() => {
    void reloadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name
    );
  }, [
    activeTableWindow.table.schema,
    activeTableWindow.table.name,
    reloadTableData,
  ]);

  const handleQuickFilter = useCallback(
    (colName: string, value: string) => {
      const nextFilters = [
        {
          id: Date.now(),
          column: colName,
          operator: "=",
          value,
          enabled: true,
        },
      ];
      setFilterBarVisible(true, activeKey);
      setFilters(nextFilters);
      setFilterCombine("AND");
      applyFilters(nextFilters, "AND", activeKey);
    },
    [activeKey, setFilterBarVisible, setFilters, setFilterCombine, applyFilters]
  );

  const handleCountExact = useCallback(
    async (includeFilters: boolean) => {
      await loadTableData(
        activeTableWindow.table.schema,
        activeTableWindow.table.name,
        { limit, offset },
        {
          refreshRows: false,
          refreshMeta: false,
          refreshStats: false,
          refreshRowCount: true,
          exactRowCount: true,
          filters:
            includeFilters && appliedFilters.length
              ? appliedFilters
              : undefined,
          filterCombine: includeFilters ? appliedFilterCombine : "AND",
        }
      );
    },
    [
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      limit,
      offset,
      loadTableData,
      appliedFilters,
      appliedFilterCombine,
    ]
  );

  /* ===========================================================================
   * Export / Import / Clone / Truncate / Drop
   * =========================================================================== */

  const onExportOpen = useCallback(
    (scope: ExportScope = "all") => {
      if (isNewTable) return;
      setExportScope(scope);
      setExportDialogOpen(true);
    },
    [isNewTable, setExportDialogOpen]
  );

  const onImportOpen = useCallback(async () => {
    if (isNewTable || isProfileLocked) return;
    const loaded = await loadDataImport();
    if (!loaded) return;
    setImportDialogOpen(true);
  }, [isNewTable, isProfileLocked, loadDataImport, setImportDialogOpen]);

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
    if (isNewTable || isProfileLocked) return;
    setTruncateDialogOpen(true);
  }, [isNewTable, isProfileLocked]);
  const onTruncateClose = useCallback(() => setTruncateDialogOpen(false), []);

  const onDropOpen = useCallback(() => {
    if (isProfileLocked) return;
    setDropDialogOpen(true);
  }, [isProfileLocked]);
  const onDropClose = useCallback(() => setDropDialogOpen(false), []);

  const handleTruncate = useCallback(
    async (opts: { restartIdentity: boolean; cascade: boolean }) => {
      if (isNewTable || isProfileLocked) return;
      if (!meta.connectionId) throw new Error("Not connected.");

      const { schema, name } = activeTableWindow.table;
      const sql = truncateTableQuery(schema, name, opts, engine);
      await rt.runSqlWithHistory({
        windowId: activeTableWindow.id,
        connectionId: meta.connectionId,
        sql,
      });
      await reloadTableData(schema, name);
    },
    [
      isNewTable,
      isProfileLocked,
      meta.connectionId,
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      activeTableWindow.id,
      engine,
      rt.runSqlWithHistory,
      reloadTableData,
    ]
  );

  const handleDrop = useCallback(async () => {
    if (isProfileLocked) return;
    if (!meta.connectionId) throw new Error("Not connected.");

    const { schema, name } = activeTableWindow.table;
    const sql = dropTableQuery(schema, name, engine);
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
    engine,
    rt.runSqlWithHistory,
    rt.refreshSchemaAndTables,
    actions.closeWindow,
  ]);

  const handleClone = useCallback(
    async (newTableName: string, copyData: boolean) => {
      if (isProfileLocked) return;
      if (!meta.connectionId) throw new Error("Not connected.");
      const { schema, name } = activeTableWindow.table;
      const createSql = cloneTableQuery(schema, name, newTableName, engine);
      await rt.runSqlWithHistory({
        windowId: activeTableWindow.id,
        connectionId: meta.connectionId,
        sql: createSql,
      });
      if (copyData) {
        const insertSql = copyTableDataQuery(
          schema,
          name,
          newTableName,
          engine
        );
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
      engine,
      rt.runSqlWithHistory,
      rt.refreshSchemaAndTables,
    ]
  );

  const handleImport = useCallback(
    async (options: {
      firstIsHeaders: boolean;
      columnMapping: import("src/hooks/useImportTableData").ImportColumnMapping;
      nullMode: import("src/hooks/useImportTableData").ImportNullMode;
      fullValidation: boolean;
    }) => {
      if (isProfileLocked) return;
      const { schema, name } = activeTableWindow.table;
      runImport({
        connectionId: meta.connectionId,
        schema,
        tableName: name,
        columns: meta.columns ?? [],
        limit,
        offset,
        engine,
        firstIsHeaders: options.firstIsHeaders,
        columnMapping: options.columnMapping,
        nullMode: options.nullMode,
        fullValidation: options.fullValidation,
        onSuccess: async () => reloadTableData(schema, name),
      });
    },
    [
      isProfileLocked,
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      meta.connectionId,
      meta.columns,
      engine,
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
          hasError ? (
            <div class="flex h-full min-h-0 flex-col overflow-hidden">
              <div class="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-sm text-neutral-400">
                Unable to load structure while the data query has an error.
              </div>
            </div>
          ) : (
            <TableStructurePane
              engine={engine}
              profileId={profileId}
              readOnly={isStructureReadOnly}
              activeTableWindow={activeTableWindow as any}
              activeTableMeta={meta}
              structPaneTab={structPaneTab}
              setStructPaneTab={setStructPaneTab}
              tableStructure={
                s.tableStructure[profileId]?.[activeTableWindow.id] ??
                EMPTY_ARRAY
              }
              tableConstraints={
                s.tableConstraints[profileId]?.[activeTableWindow.id] ??
                EMPTY_ARRAY
              }
              tableList={rt.metadata.get({ metaKey: rt.metaKey }).tables}
              onDataChange={onDataChange}
              onAddNewColumn={onAddColumn}
              onDeleteColumn={onDeleteColumn}
              deletedStructureRows={extractDeleted(
                patches,
                DATA_KEYS.structure
              )}
              onAddIndex={onAddIndex}
              onDeleteIndex={onDeleteIndex}
              deletedConstraintRows={extractDeleted(
                patches,
                DATA_KEYS.constraints
              )}
            />
          )
        ) : (
          <div class="flex h-full min-h-0 flex-col">
            {filterBarVisible && (
              <TableFilterBar
                tableKey={activeKey}
                schema={activeTableWindow.table.schema}
                tableName={activeTableWindow.table.name}
                engine={engine}
                columns={tableColumns}
                filters={filters}
                filterCombine={filterCombine}
                appliedFilters={appliedFilters}
                limit={limit}
                offset={offset}
                sortState={sortState}
                setFilterVisible={setFilterBarVisible}
                onFiltersChange={setFilters}
                onFilterCombineChange={setFilterCombine}
                onApply={applyFilters}
                onClear={clearFilters}
                onExport={isNewTable ? undefined : onExportOpen}
                onImport={onImportOpen}
                queryError={hasError}
                onShowSql={(sql) => {
                  setSqlPreview(sql);
                  setSqlDialogOpen(true);
                }}
              />
            )}
            <div class="min-h-0 flex-1">
              <TableData
                key={activeKey}
                columns={tableColumns}
                baseRows={hasError ? 0 : renderBasePageTotal}
                totalRows={hasError ? 0 : visiblePageTotal}
                getRowAt={hasError ? getEmptyRowAt : getRowAt}
                readOnly={isDataReadOnly}
                onCellChange={
                  hasError || isDataReadOnly ? undefined : onDataChange
                }
                patches={hasError ? null : extractPatches(patches)}
                newRowKeys={hasError ? [] : newRowKeys}
                onAddRow={
                  !hasError && canAddDataRow
                    ? () => {
                        handleAddRow(
                          tableColumns,
                          loadedRowCount,
                          onDataChange
                        );
                      }
                    : undefined
                }
                onDeleteRow={(rowIndex, rowKey) => {
                  if (hasError || isDataReadOnly) return;
                  handleDeleteRow(rowIndex, renderOffset, rowKey);
                }}
                onRefresh={handleContextRefresh}
                onExportCurrentPage={
                  isNewTable ? undefined : () => onExportOpen("page")
                }
                onImportData={
                  !hasError && !isDataReadOnly ? onImportOpen : undefined
                }
                onQuickFilter={handleQuickFilter}
                schema={activeTableWindow.table.schema}
                tableName={activeTableWindow.table.name}
                engine={engine}
                deletedRows={
                  hasError ? EMPTY_SET : extractDeleted(patches, DATA_KEYS.data)
                }
                rowsVersion={hasError ? 0 : (rowsInfo?.version ?? 0)}
                foreignKeyMap={foreignKeyMap}
                onNavigateFk={handleNavigateFk}
                sortState={sortState}
                onChangeSort={handleChangeSort}
                onSelectedRowDetailChange={handleSelectedRowDetailChange}
              />
            </div>
          </div>
        )}
      </div>

      <TableFooter
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        structPaneTab={structPaneTab}
        filterBarVisible={filterBarVisible}
        limit={renderLimit}
        offset={renderOffset}
        loadedMax={hasError ? -1 : loadedMax}
        totalRows={hasError ? 0 : footerTotalRows}
        rowCountIsEstimated={!!meta.rowCountIsEstimated}
        onPageChange={pageChange}
        onCountExact={handleCountExact}
        onAddRow={() => {
          if (!canAddDataRow) return;
          handleAddRow(meta.columns ?? [], loadedRowCount, onDataChange);
        }}
        onAddColumn={isStructureReadOnly ? () => {} : onAddColumn}
        onAddIndex={isStructureReadOnly ? () => {} : onAddIndex}
        onFilters={() => setFilterBarVisible((v) => !v, activeKey)}
        canAddRow={canAddDataRow}
        readOnly={
          viewMode === "structure" ? isStructureReadOnly : isDataReadOnly
        }
      />

      <MainTableDialogs
        sqlDialogOpen={sqlDialogOpen}
        setSqlDialogOpen={setSqlDialogOpen}
        sqlPreview={sqlPreview}
        exportDialogOpen={exportDialogOpen}
        setExportDialogOpen={setExportDialogOpen}
        importDialogOpen={importDialogOpen}
        onImportClose={onImportClose}
        cloneDialogOpen={cloneDialogOpen}
        onCloneClose={onCloneClose}
        truncateDialogOpen={truncateDialogOpen}
        onTruncateClose={onTruncateClose}
        dropDialogOpen={dropDialogOpen}
        onDropClose={onDropClose}
        errorDialogOpen={errorDialogOpen}
        setErrorDialogOpen={setErrorDialogOpen}
        hasError={hasError}
        activeKey={activeKey}
        errorText={errorText}
        onErrorDismissPersist={() => dismissCurrentError()}
        connectionId={meta.connectionId}
        schema={activeTableWindow.table.schema}
        tableName={activeTableWindow.table.name}
        columns={meta.columns ?? []}
        constraints={meta.constraints ?? null}
        totalRows={exportScope === "page" ? visiblePageTotal : totalRows}
        appliedFilters={appliedFilters}
        appliedFilterCombine={appliedFilterCombine}
        exportPagination={
          exportScope === "page"
            ? { limit: renderLimit, offset: renderOffset }
            : undefined
        }
        exportSortState={sortState}
        engine={engine}
        dataImportPreview={dataImportPreview}
        importError={importError}
        importBusy={importBusy}
        importProgressState={importProgressState}
        handleImport={handleImport}
        handleClone={handleClone}
        handleTruncate={handleTruncate}
        handleDrop={handleDrop}
      />
    </div>
  );
}
