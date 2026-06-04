import { getErrorMessage } from "../helpers";
import { patchMeta } from "../metaPatch";
import {
  loadMongoOverview,
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
  const { key, plan, prev, flags, setMeta, setColumnsCache, setSizeInfoCache } =
    ctx;

  try {
    let mongoColumns = asColumnRows(prev);
    let mongoStructure = prev.structure ?? [];
    let mongoRowCount = typeof prev.rowCount === "number" ? prev.rowCount : 0;
    let mongoSizeInfo = prev.sizeInfo ?? null;

    if (plan.needColumns || plan.needMeta || plan.needRowCount) {
      const overview = await loadMongoOverview({
        connId: ctx.connId,
        schema: ctx.schema,
        tableName: ctx.tableName,
      });
      mongoColumns = overview.columns;
      mongoStructure = overview.structure;
      mongoRowCount = overview.rowCount;

      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns: mongoColumns,
          structure: mongoStructure,
          constraints: overview.constraints,
          foreignKeys: [],
          rowCount: mongoRowCount,
          rowCountIsEstimated: false,
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
      });

      if (rowsRes.columns.length > 0) {
        mongoColumns = rowsRes.columns;
      }
      mongoRowCount = rowsRes.rowCount || mongoRowCount;

      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns: mongoColumns,
          rowCount: mongoRowCount,
          sizeInfo: mongoSizeInfo,
          rowCountIsEstimated: false,
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
