import { useCallback, useEffect, useMemo } from "preact/hooks";
import type { Dispatch, StateUpdater } from "preact/hooks";
import type { TableFilterCondition, TableSort } from "src/lib/queries/sql";
import { tableRowsStreamLoadPercent } from "src/utils/tableRowsProgress";
import { useConnectionStore } from "src/stores/connection";

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

const loadedQuerySignatureByTable = new Map<string, string>();
const loadedRowCountSignatureByTable = new Map<string, string>();
const loadedRowsDataSignatureByTable = new Map<string, string>();
const dismissedTableErrorByKey = new Map<string, string>();

type ActiveTableWindow = {
  id: string;
  table: { schema: string; name: string };
};

type SettledPagination = { limit: number; offset: number };

export function useMainTableDataLoading(args: {
  activeKey: string;
  activeTableWindow: ActiveTableWindow;
  engine: string;
  limit: number;
  offset: number;
  startedRef: { current: string | null };
  appliedFilters: TableFilterCondition[];
  appliedFilterCombine: "AND" | "OR";
  filterApplySeq: number;
  sortState: TableSort | null;
  settledPagination: SettledPagination;
  setSettledPagination: Dispatch<StateUpdater<SettledPagination>>;
  progressNow: number;
  setProgressNow: Dispatch<StateUpdater<number>>;
  viewMode: "data" | "structure";
  setErrorDialogOpen: Dispatch<StateUpdater<boolean>>;
  loadTableData: (
    schema: string,
    table: string,
    pagination: { limit: number; offset: number },
    options: {
      forceRows?: boolean;
      refreshRowCount?: boolean;
      refreshRows?: boolean;
      refreshForeignKeys?: boolean;
      refreshStats?: boolean;
      refreshMeta?: boolean;
      filters?: TableFilterCondition[];
      filterCombine?: "AND" | "OR";
      sortBy?: TableSort | null;
    }
  ) => Promise<void>;
  rerender: () => void;
}) {
  const {
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
    viewMode,
    setErrorDialogOpen,
    loadTableData,
    rerender,
  } = args;

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
    [activeKey, appliedFilterCombine, filterSignature, sortState, filterApplySeq]
  );

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

    if (
      currentMeta.error &&
      !shouldForceReload &&
      !shouldRefreshRowCount &&
      !shouldResetRowsCache
    ) {
      loadedQuerySignatureByTable.set(activeKey, activeQuerySignature);
      return;
    }

    loadedQuerySignatureByTable.set(activeKey, activeQuerySignature);
    rerender();

    void loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset },
      {
        forceRows: shouldResetRowsCache,
        refreshRowCount: shouldRefreshRowCount,
        refreshRows: shouldForceReload,
        refreshForeignKeys: !Array.isArray(currentMeta.foreignKeys),
        refreshStats: false,
        filters: appliedFilters.length ? appliedFilters : undefined,
        filterCombine: appliedFilterCombine,
        sortBy: sortState,
      }
    )
      .then(() => {
        if (shouldRefreshRowCount) {
          loadedRowCountSignatureByTable.set(activeKey, rowCountSignature);
        }
        loadedRowsDataSignatureByTable.set(activeKey, rowsDataSignature);
        rerender();
      })
      .catch(() => {
        rerender();
      });
  }, [
    startedRef,
    activeQuerySignature,
    engine,
    activeKey,
    rowCountSignature,
    rowsDataSignature,
    rerender,
    loadTableData,
    activeTableWindow,
    limit,
    offset,
    appliedFilters,
    appliedFilterCombine,
    sortState,
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
  }, [activeKey, handleLoadRows, rerender]);

  const meta = useConnectionStore.getState().tableDataMap[activeKey] ?? EMPTY_META;
  const rowsInfo = useConnectionStore.getState().getRowsWindowInfo(activeKey) ?? null;
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
  }, [hasError, errorText, activeKey, setErrorDialogOpen]);

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
    meta.error,
    meta.structure,
    meta.constraints,
    loadTableData,
    limit,
    offset,
  ]);

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
  const rowsKnownEmpty =
    !!rowsInfo && rowsMatchRequestedOffset && !rowsRunning && loadedMax < streamOffset;
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

  const shouldShowLoading =
    !hasError &&
    (!columnsLoaded ||
      !rowsInfo ||
      (!hasRenderedTableBefore && (!currentPageLoaded || !queryMatchesRenderedData)));

  useEffect(() => {
    if (!shouldShowLoading || !rowsInfo?.running) return;
    const id = window.setInterval(() => setProgressNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [shouldShowLoading, rowsInfo?.running, setProgressNow]);

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
  }, [currentPageLoaded, limit, offset, setSettledPagination]);

  const dismissCurrentError = useCallback(() => {
    if (errorText) {
      dismissedTableErrorByKey.set(activeKey, errorText);
    }
    setErrorDialogOpen(false);
  }, [activeKey, errorText, setErrorDialogOpen]);

  return {
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
    clearLoadedQuerySignature: (key: string) => loadedQuerySignatureByTable.delete(key),
  };
}
