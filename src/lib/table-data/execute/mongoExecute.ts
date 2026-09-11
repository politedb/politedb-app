import { getErrorMessage } from "../helpers";
import { patchMeta } from "../metaPatch";
import { enabledMongoFilters } from "src/lib/queries/mongo";
import {
  loadMongoOverview,
  loadMongoRowCount,
  loadMongoRows,
  loadMongoSizeInfo,
} from "../loaders/mongoLoader";
import {
  asColumnRows,
  patchWithConn,
  type LoadExecutionContext,
  type LoadExecutionResult,
} from "./types";

export async function executeMongoLoad(
  ctx: LoadExecutionContext
): Promise<LoadExecutionResult> {
  const {
    key,
    plan,
    prev,
    flags,
    setMeta,
    setColumnsCache,
    setSizeInfoCache,
    addLogQuery,
  } = ctx;

  try {
    let mongoColumns = asColumnRows(prev);
    let mongoStructure = prev.structure ?? [];
    let mongoRowCount = typeof prev.rowCount === "number" ? prev.rowCount : 0;
    let mongoRowCountIsEstimated = !!prev.rowCountIsEstimated;
    let mongoSizeInfo = prev.sizeInfo ?? null;
    const hasFilters = enabledMongoFilters(flags.filters).length > 0;
    const useExactCount = !!flags.exactRowCount || hasFilters;

    if (
      plan.needColumns ||
      plan.needMeta ||
      (plan.needRowCount && !useExactCount)
    ) {
      const overview = await loadMongoOverview({
        connId: ctx.connId,
        schema: ctx.schema,
        tableName: ctx.tableName,
      });
      mongoColumns = overview.columns;
      mongoStructure = overview.structure;
      if (!useExactCount) {
        mongoRowCount = overview.rowCount;
        mongoRowCountIsEstimated = true;
      }

      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns: mongoColumns,
          structure: mongoStructure,
          constraints: overview.constraints,
          foreignKeys: [],
          rowCount: mongoRowCount,
          rowCountIsEstimated: mongoRowCountIsEstimated,
          busy: false,
        }),
      });
      try {
        setColumnsCache(key, mongoColumns);
      } catch {}
    }

    if (plan.needSizeInfo || !mongoSizeInfo) {
      mongoSizeInfo = await loadMongoSizeInfo({
        connId: ctx.connId,
        schema: ctx.schema,
        tableName: ctx.tableName,
      });

      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          sizeInfo: mongoSizeInfo,
          busy: false,
        }),
      });

      try {
        setSizeInfoCache(key, mongoSizeInfo);
      } catch {}
    }

    if (plan.needRows) {
      const rowsRes = await loadMongoRows({
        key,
        connId: ctx.connId,
        schema: ctx.schema,
        tableName: ctx.tableName,
        limit: ctx.limit,
        offset: ctx.offset,
        resetCache: !!flags.force || !!flags.forceRows,
        forceRefresh: !!flags.forceRefresh,
        filters: flags.filters,
        filterCombine: flags.filterCombine ?? "AND",
        sortBy: flags.sortBy ?? null,
        exactCount: useExactCount,
        addLogQuery,
      });

      if (mongoColumns.length === 0 && rowsRes.columns.length > 0) {
        mongoColumns = rowsRes.columns;
      } else if (rowsRes.columns.length > mongoColumns.length) {
        mongoColumns = rowsRes.columns;
      }
      mongoRowCount = rowsRes.rowCount;
      mongoRowCountIsEstimated = rowsRes.rowCountIsEstimated;

      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns: mongoColumns,
          rowCount: mongoRowCount,
          sizeInfo: mongoSizeInfo,
          rowCountIsEstimated: mongoRowCountIsEstimated,
          busy: false,
        }),
      });
    } else if (plan.needRowCount && useExactCount) {
      const countRes = await loadMongoRowCount({
        connId: ctx.connId,
        schema: ctx.schema,
        tableName: ctx.tableName,
        filters: flags.filters,
        filterCombine: flags.filterCombine ?? "AND",
        addLogQuery,
      });
      mongoRowCount = countRes.rowCount;
      mongoRowCountIsEstimated = countRes.estimated;
      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          rowCount: mongoRowCount,
          rowCountIsEstimated: mongoRowCountIsEstimated,
          busy: false,
        }),
      });
    }

    patchMeta(setMeta, key, prev, { busy: false, error: null });
  } catch (e) {
    patchMeta(setMeta, key, prev, {
      busy: false,
      error: getErrorMessage(e),
    });
  }

  return "done";
}
