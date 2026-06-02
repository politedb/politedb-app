import { getErrorMessage } from "../helpers";
import { patchMeta } from "../metaPatch";
import { loadRedisOverview, loadRedisRows } from "../loaders/redisLoader";
import {
  asColumnRows,
  patchWithConn,
  type LoadExecutionContext,
  type LoadExecutionResult,
} from "./types";

export async function executeRedisLoad(
  ctx: LoadExecutionContext
): Promise<LoadExecutionResult> {
  const { key, plan, prev, flags, setMeta, setColumnsCache, setSizeInfoCache } =
    ctx;

  try {
    let redisColumns = asColumnRows(prev);
    let redisStructure = prev.structure ?? [];
    let redisRowCount = typeof prev.rowCount === "number" ? prev.rowCount : 0;
    let redisSizeInfo = prev.sizeInfo ?? null;

    if (plan.needColumns || plan.needMeta) {
      const overview = await loadRedisOverview({
        connId: ctx.connId,
        tableName: ctx.tableName,
      });
      redisColumns = overview.columns;
      redisStructure = overview.structure;
      redisRowCount = overview.rowCount;

      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns: redisColumns,
          structure: redisStructure,
          constraints: [],
          foreignKeys: [],
          rowCount: redisRowCount,
          rowCountIsEstimated: false,
          busy: false,
        }),
      });
      try {
        setColumnsCache(key, redisColumns);
      } catch {}
    }

    if (plan.needRows || plan.needRowCount || plan.needSizeInfo) {
      const rowsRes = await loadRedisRows({
        key,
        connId: ctx.connId,
        tableName: ctx.tableName,
        limit: ctx.limit,
        offset: ctx.offset,
        resetCache: !!flags.force || !!flags.forceRows,
      });

      if (rowsRes.columns.length > 0) {
        redisColumns = rowsRes.columns;
      }
      redisRowCount = rowsRes.rowCount;
      redisSizeInfo = rowsRes.sizeInfo;

      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns: redisColumns,
          rowCount: redisRowCount,
          sizeInfo: redisSizeInfo,
          rowCountIsEstimated: false,
          busy: false,
        }),
      });

      try {
        setSizeInfoCache(key, redisSizeInfo);
      } catch {}
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
