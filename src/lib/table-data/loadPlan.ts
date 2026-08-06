import { useConnectionStore } from "src/stores/connection";
import type { DatabaseEngine } from "src/types";
import { allowsEmptyColumnList } from "src/lib/engines";
import {
  DEFAULT_LIMIT,
  DEFAULT_OFFSET,
  type TablePagination,
} from "./constants";
import type { LoadFlags, LoadPlan } from "./types";

export function computeLoadPlan(params: {
  key: string;
  prev: any;
  engine?: DatabaseEngine;
  flags: LoadFlags;
  pagination?: TablePagination;
}): LoadPlan {
  const { key, prev, engine, flags, pagination } = params;

  const force = !!flags.force;
  const forceRefresh = !!flags.forceRefresh;
  const forceRows = !!flags.forceRows;
  const refreshRowCount = !!flags.refreshRowCount;
  const refreshRows = flags.refreshRows ?? true;
  const refreshMeta = flags.refreshMeta ?? false;
  const refreshForeignKeys = flags.refreshForeignKeys ?? false;
  const refreshStats = flags.refreshStats ?? false;

  const limit = pagination?.limit ?? DEFAULT_LIMIT;
  const offset = pagination?.offset ?? DEFAULT_OFFSET;

  const hasColumnsArray = Array.isArray(prev.columns);
  const hasColumns = allowsEmptyColumnList(engine)
    ? hasColumnsArray
    : hasColumnsArray && prev.columns.length > 0;

  const rowsInfo = useConnectionStore.getState().getRowsWindowInfo(key);
  const hasRowsWindow = !!rowsInfo;

  const rowsMatchOffset = (rowsInfo?.streamOffset ?? -1) === offset;
  const hasAnyRowForPage =
    rowsMatchOffset && typeof rowsInfo?.loadedMax === "number"
      ? rowsInfo.loadedMax >= offset
      : false;

  const hasRowCount = typeof prev.rowCount === "number" && prev.rowCount >= 0;
  const hasSizeInfo = !!prev.sizeInfo;

  const hasForeignKeys = Array.isArray(prev.foreignKeys);

  const isFirstLoad = !hasColumns || !hasRowsWindow;

  const needColumns = force || isFirstLoad || !hasColumns;

  const paginationChanged = !rowsMatchOffset;
  const needRows =
    force ||
    forceRefresh ||
    forceRows ||
    isFirstLoad ||
    refreshRows ||
    paginationChanged ||
    (!hasAnyRowForPage && !rowsInfo?.running);

  const needRowCount =
    force ||
    refreshRowCount ||
    (isFirstLoad && !hasRowCount) ||
    (!isFirstLoad && (!hasRowCount || refreshStats));
  const needSizeInfo = force || !hasSizeInfo || refreshStats;
  const needMeta = force || refreshMeta;
  const needForeignKeys = force || refreshForeignKeys || !hasForeignKeys;

  const needAnyMetaWork =
    needColumns || needRowCount || needSizeInfo || needMeta || needForeignKeys;

  const desiredCap = Math.max(1000, limit * 4);
  const capMismatch = rowsInfo ? rowsInfo.cap !== desiredCap : true;
  const needRowsWithLimit =
    needRows ||
    (capMismatch &&
      (refreshRows || force || forceRefresh || forceRows || paginationChanged));

  return {
    key,
    prev,
    force,
    isFirstLoad,
    needColumns,
    needRows: needRowsWithLimit,
    needRowCount,
    needSizeInfo,
    needMeta,
    needForeignKeys,
    needAnyMetaWork,
  };
}

export function shouldDoAnything(p: LoadPlan) {
  return (
    p.needColumns ||
    p.needRows ||
    p.needRowCount ||
    p.needSizeInfo ||
    p.needMeta ||
    p.needForeignKeys
  );
}

export function buildLoadSignature(params: {
  key: string;
  pagination?: TablePagination;
  flags: LoadFlags;
}) {
  const { key, pagination, flags } = params;
  const filters = (flags.filters ?? []).map((f) => ({
    column: f.column ?? "",
    operator: f.operator ?? "",
    value: f.value ?? "",
    enabled: !!f.enabled,
  }));

  return JSON.stringify({
    key,
    limit: pagination?.limit ?? DEFAULT_LIMIT,
    offset: pagination?.offset ?? DEFAULT_OFFSET,
    force: !!flags.force,
    forceRefresh: !!flags.forceRefresh,
    forceRows: !!flags.forceRows,
    refreshRowCount: !!flags.refreshRowCount,
    refreshRows: flags.refreshRows ?? true,
    refreshMeta: flags.refreshMeta ?? false,
    refreshForeignKeys: flags.refreshForeignKeys ?? false,
    refreshStats: flags.refreshStats ?? false,
    filterCombine: flags.filterCombine ?? "AND",
    sortBy: flags.sortBy ?? null,
    filters,
  });
}
