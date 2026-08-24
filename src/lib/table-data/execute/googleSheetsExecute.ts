import { getErrorMessage } from "../helpers";
import { patchMeta } from "../metaPatch";
import {
  loadGoogleSheetsOverview,
  loadGoogleSheetsRows,
} from "../loaders/googleSheetsLoader";
import {
  asColumnRows,
  patchWithConn,
  type LoadExecutionContext,
  type LoadExecutionResult,
} from "./types";

export async function executeGoogleSheetsLoad(
  ctx: LoadExecutionContext
): Promise<LoadExecutionResult> {
  const { key, plan, prev, flags, setMeta, setColumnsCache } = ctx;
  try {
    let columns = asColumnRows(prev);
    let rowCount = typeof prev.rowCount === "number" ? prev.rowCount : 0;
    if (plan.needColumns || plan.needMeta || plan.needRowCount) {
      const overview = await loadGoogleSheetsOverview({
        connId: ctx.connId,
        tableName: ctx.tableName,
      });
      columns = overview.columns;
      rowCount = overview.rowCount;
      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns,
          structure: overview.structure,
          constraints: [],
          foreignKeys: [],
          rowCount,
          rowCountIsEstimated: true,
          busy: false,
        }),
      });
      setColumnsCache(key, columns);
    }

    if (plan.needRows) {
      const result = await loadGoogleSheetsRows({
        key,
        connId: ctx.connId,
        tableName: ctx.tableName,
        limit: ctx.limit,
        offset: ctx.offset,
        resetCache: !!flags.force || !!flags.forceRows,
        forceRefresh: !!flags.forceRefresh,
      });
      columns = result.columns.length ? result.columns : columns;
      rowCount = Math.max(rowCount, result.rowCount);
      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns,
          rowCount,
          rowCountIsEstimated: true,
          busy: false,
        }),
      });
    }
    patchMeta(setMeta, key, prev, { busy: false, error: null });
  } catch (error) {
    patchMeta(setMeta, key, prev, {
      busy: false,
      error: getErrorMessage(error),
    });
  }
  return "done";
}
