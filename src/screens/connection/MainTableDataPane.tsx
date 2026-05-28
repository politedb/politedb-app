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
  type TableSort,
} from "src/hooks/queries";
import { TableForeignKey } from "src/types";
import { tableRowsStreamLoadPercent } from "src/utils/tableRowsProgress";
import { ErrorDialog } from "src/components/modal/ErrorDialog";

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
  rowCountIsEstimated: false,
  busy: false,
  error: null,
};

const EMPTY_ARRAY: any[] = [];
const EMPTY_SET = new Set<number>();
const loadedQuerySignatureByTable = new Map<string, string>();
const loadedRowCountSignatureByTable = new Map<string, string>();
const loadedRowsDataSignatureByTable = new Map<string, string>();
/** User-dismissed execution errors survive pane remounts (e.g. toggling query history). */
const dismissedTableErrorByKey = new Map<string, string>();

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
  const [structPaneTab, setStructPaneTab] = useState<StructPaneTab>("columns");
  const [, forceUpdate] = useState(0);
  const [sqlPreview, setSqlPreview] = useState("");
  const [sqlDialogOpen, setSqlDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [truncateDialogOpen, setTruncateDialogOpen] = useState(false);
  const [dropDialogOpen, setDropDialogOpen] = useState(false);
  const [sortState, setSortState] = useState<TableSort | null>(null);
  const [progressNow, setProgressNow] = useState(() => Date.now());
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [settledPagination, setSettledPagination] = useState(() => ({
    limit,
    offset,
  }));

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
    filterApplySeq,
    setFilters,
    setFilterCombine,
    setFilterBarVisible,
    handleApplyFilters,
    handleClearFilters,
  } = useTableFilter(startedRef, activeKey);

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
    setSortState(null);
    clearSelectedRowDetail(activeKey);
    setSettledPagination({ limit, offset });
  }, [activeKey, clearSelectedRowDetail]);

  const handleSelectedRowDetailChange = useCallback(
    (detail: SelectedRowDetail | null) => {
      setSelectedRowDetail(activeKey, detail);
    },
    [activeKey, setSelectedRowDetail]
  );

  const filterSignature = useMemo(
    () =>
      JSON.stringify(
        appliedFilters.map((filter) => ({
          id: filter.id,
          column: filter.column,
          operator: filter.operator,
          value: filter.value,
          enabled: filter.enabled,
        }))
      ),
    [appliedFilters]
  );

  const activeQuerySignature = useMemo(
    () =>
      `${activeKey}:${limit}:${offset}:${appliedFilterCombine}:${filterSignature}:${sortState?.colName ?? ""}:${sortState?.direction ?? ""}:${filterApplySeq}`,
    [
      activeKey,
      limit,
      offset,
      appliedFilterCombine,
      filterSignature,
      sortState,
      filterApplySeq,
    ]
  );

  const rowCountSignature = useMemo(
    () =>
      `${activeKey}:${appliedFilterCombine}:${filterSignature}:${filterApplySeq}`,
    [activeKey, appliedFilterCombine, filterSignature, filterApplySeq]
  );

  const rowsDataSignature = useMemo(
    () =>
      `${activeKey}:${appliedFilterCombine}:${filterSignature}:${sortState?.colName ?? ""}:${sortState?.direction ?? ""}:${filterApplySeq}`,
    [
      activeKey,
      appliedFilterCombine,
      filterSignature,
      sortState,
      filterApplySeq,
    ]
  );

  /* ===========================================================================
   * Subscribe minimal state
   * =========================================================================== */

  const handleLoadRows = useCallback(async () => {
    if (startedRef.current === activeQuerySignature) return;
    startedRef.current = activeQuerySignature;

    const isRedisTable = engine === "redis";
    const shouldForceReload =
      isRedisTable ||
      loadedQuerySignatureByTable.get(activeKey) !== activeQuerySignature;
    const currentMeta =
      useConnectionStore.getState().tableDataMap[activeKey] ?? EMPTY_META;
    const shouldRefreshRowCount =
      isRedisTable ||
      typeof currentMeta.rowCount !== "number" ||
      loadedRowCountSignatureByTable.get(activeKey) !== rowCountSignature;
    const shouldResetRowsCache =
      isRedisTable ||
      loadedRowsDataSignatureByTable.get(activeKey) !== rowsDataSignature;

    useConnectionStore.getState().initRows(activeKey, 5000);

    // Keep table-local error stable. Avoid auto-retrying the exact same query
    // signature continuously, which causes error-state flicker.
    if (
      currentMeta.error &&
      !shouldForceReload &&
      !shouldRefreshRowCount &&
      !shouldResetRowsCache
    ) {
      loadedQuerySignatureByTable.set(activeKey, activeQuerySignature);
      return;
    }

    // Mark this query signature as the active render target immediately so
    // slow auxiliary metadata work (COUNT, size info, FK/structure) does not
    // keep the whole table pane in a blocking loading state.
    loadedQuerySignatureByTable.set(activeKey, activeQuerySignature);
    rerender();

    // Reuse cached table state when switching back to a table with the same
    // query signature. Force a reload only when the effective query changed.
    void loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset },
      {
        forceRows: shouldResetRowsCache,
        refreshRowCount: shouldRefreshRowCount,
        refreshRows: shouldForceReload,
        // Foreign keys are useful for cross-table navigation, but structure /
        // constraints should stay lazy until the Structure tab is opened.
        refreshForeignKeys: !Array.isArray(currentMeta.foreignKeys),
        refreshStats: false,
        filters: appliedFilters.length ? appliedFilters : undefined,
        filterCombine: appliedFilterCombine,
        sortBy: sortState,
      }
    ).catch(() => {
      // Error state is already written into the store by loadTableData.
      rerender();
    });

    if (shouldRefreshRowCount) {
      loadedRowCountSignatureByTable.set(activeKey, rowCountSignature);
    }
    loadedRowsDataSignatureByTable.set(activeKey, rowsDataSignature);
  }, [
    activeTableWindow,
    activeKey,
    engine,
    appliedFilters,
    appliedFilterCombine,
    activeQuerySignature,
    rowCountSignature,
    rowsDataSignature,
    sortState,
    filterApplySeq,
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
        meta?.busy,
        meta?.columns?.length,
        meta?.rowCount,
        meta?.foreignKeys?.length,
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
  const newRowKeys = useMemo(
    () => Object.keys((patches?.create?.data ?? {}) as Record<string, unknown>),
    [patches]
  );

  const dataPatches = useMemo(() => extractPatches(patches), [patches]);
  const deletedDataRows = useMemo(
    () => extractDeleted(patches, DATA_KEYS.data),
    [patches]
  );

  const hasError = !!(meta.error || rowsInfo?.error);
  const errorText = String(meta.error || rowsInfo?.error || "");

  useEffect(() => {
    if (!hasError) {
      dismissedTableErrorByKey.delete(activeKey);
      setErrorDialogOpen(false);
      return;
    }
    if (dismissedTableErrorByKey.get(activeKey) === errorText) return;
    setErrorDialogOpen(true);
  }, [hasError, errorText, activeKey]);

  // Lazy-load structure/constraints when switching to Structure view.
  useEffect(() => {
    if (viewMode !== "structure") return;
    if (!activeTableWindow) return;
    if (meta.busy) return;
    if (meta.error) return;

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
        refreshForeignKeys: false,
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
  const loadedRowCount =
    loadedMax >= streamOffset ? loadedMax - streamOffset + 1 : 0;
  const rowsMatchRequestedOffset = streamOffset === offset;

  const basePageTotal = useMemo(() => {
    if (typeof meta.rowCount === "number") {
      return Math.min(limit, Math.max(0, meta.rowCount - offset));
    }
    return limit;
  }, [meta.rowCount, limit, offset]);

  const columnsLoaded =
    Array.isArray(meta.columns) &&
    (engine === "mongo" || engine === "cassandra" || meta.columns.length > 0);
  const foreignKeysLoaded = Array.isArray(meta.foreignKeys);
  const rowsKnownEmpty =
    !!rowsInfo &&
    rowsMatchRequestedOffset &&
    !rowsRunning &&
    loadedMax < streamOffset;
  const hasAppliedFilters = appliedFilters.some(
    (filter) => filter.enabled && Boolean((filter.column ?? "").trim())
  );
  const currentPageLoaded =
    rowsMatchRequestedOffset &&
    (rowsKnownEmpty ||
      (!rowsRunning &&
        (hasAppliedFilters ||
          typeof meta.rowCount !== "number" ||
          loadedRowCount >= basePageTotal)));
  const showingStalePage =
    !currentPageLoaded &&
    (settledPagination.limit !== limit || settledPagination.offset !== offset);
  const renderLimit = showingStalePage ? settledPagination.limit : limit;
  const renderOffset = showingStalePage ? settledPagination.offset : offset;
  const hasRenderedTableBefore = loadedQuerySignatureByTable.has(activeKey);
  const queryMatchesRenderedData =
    loadedQuerySignatureByTable.get(activeKey) === activeQuerySignature;

  // Only show full-page loading on initial load. During refresh keep the table visible with
  // existing (stale) data so the screen state stays the same and data updates silently.
  const shouldShowLoading =
    !hasError &&
    (!columnsLoaded ||
      !rowsInfo ||
      (!hasRenderedTableBefore &&
        (!currentPageLoaded || !queryMatchesRenderedData)));

  useEffect(() => {
    if (!shouldShowLoading || !rowsInfo?.running) return;

    const id = window.setInterval(() => setProgressNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [shouldShowLoading, rowsInfo?.running]);

  const rowsLoadProgress = useMemo(() => {
    if (!rowsInfo?.running) return null;
    return tableRowsStreamLoadPercent(
      rowsInfo,
      meta.rowCount as number | null | undefined,
      progressNow
    );
  }, [rowsInfo, meta.rowCount, progressNow]);

  useEffect(() => {
    if (!currentPageLoaded) return;
    setSettledPagination((prev) =>
      prev.limit === limit && prev.offset === offset ? prev : { limit, offset }
    );
  }, [currentPageLoaded, limit, offset]);

  // Foreign key metadata powers cross-table navigation, but it can be loaded
  // after the first page of rows is already visible.
  useEffect(() => {
    if (viewMode !== "data") return;
    if (!activeTableWindow) return;
    if (meta.busy) return;
    if (meta.error || rowsInfo?.error) return;
    if (foreignKeysLoaded) return;
    if (!columnsLoaded) return;
    if (!rowsInfo) return;
    if (!currentPageLoaded) return;

    void loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset },
      {
        refreshRows: false,
        refreshForeignKeys: true,
        refreshStats: false,
      }
    );
  }, [
    viewMode,
    activeTableWindow,
    meta.busy,
    foreignKeysLoaded,
    columnsLoaded,
    rowsInfo,
    currentPageLoaded,
    loadTableData,
    limit,
    offset,
  ]);

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

  const tableColumns = meta.columns ?? [];
  const columnsKey = useMemo(
    () => tableColumns.map((col) => col.name).join("\0"),
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
    if (isDataReadOnly || hasError || viewMode !== "data") {
      registerRowFieldEditHandler(activeKey, undefined);
      return;
    }

    const handler = (
      rowIndex: number,
      columnName: string,
      newValue: string
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
      loadedQuerySignatureByTable.delete(refKey);

      // Allow row load effect to run even when navigating within the same table.
      startedRef.current = null;

      await actions.selectTable({ schema: refSchema, name: refTable });
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
      const sql = truncateTableQuery(schema, name, opts, engine);
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
                columns={meta.columns ?? []}
                filters={filters}
                filterCombine={filterCombine}
                appliedFilters={appliedFilters}
                limit={limit}
                offset={offset}
                sortState={sortState}
                setFilterVisible={setFilterBarVisible}
                onFiltersChange={setFilters}
                onFilterCombineChange={setFilterCombine}
                onApply={handleApplyFilters}
                onClear={handleClearFilters}
                onExport={onExportOpen}
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
                columns={meta.columns ?? []}
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
                          meta.columns ?? [],
                          loadedRowCount,
                          onDataChange
                        );
                      }
                    : undefined
                }
                onDeleteRow={(rowIndex) => {
                  if (hasError || isDataReadOnly) return;
                  handleDeleteRow(rowIndex, renderOffset);
                }}
                deletedRows={
                  hasError ? EMPTY_SET : extractDeleted(patches, DATA_KEYS.data)
                }
                rowsVersion={hasError ? 0 : (rowsInfo?.version ?? 0)}
                foreignKeyMap={foreignKeyMap}
                onNavigateFk={handleNavigateFk}
                sortState={sortState}
                onChangeSort={(nextSort) => {
                  setSortState(nextSort);
                  if (renderOffset !== 0) {
                    pageChange(limit, 0);
                  }
                }}
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
          engine={engine}
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

      {errorDialogOpen && (
        <ErrorDialog
          open
          variant="execution"
          backdropClassName="bg-transparent"
          error={errorText}
          onClose={() => {
            setErrorDialogOpen(false);
            if (hasError) {
              dismissedTableErrorByKey.set(activeKey, errorText);
            }
          }}
        />
      )}
    </div>
  );
}
