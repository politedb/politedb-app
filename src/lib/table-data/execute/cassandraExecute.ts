import { getErrorMessage } from "../helpers";
import { patchMeta } from "../metaPatch";
import {
  loadCassandraOverview,
  loadCassandraRows,
  resolveCassandraKeyspaceForLoad,
} from "../loaders/cassandraLoader";
import {
  asColumnRows,
  patchWithConn,
  type LoadExecutionContext,
  type LoadExecutionResult,
} from "./types";

export async function executeCassandraLoad(
  ctx: LoadExecutionContext
): Promise<LoadExecutionResult> {
  const { key, plan, prev, flags, setMeta, setColumnsCache } = ctx;

  try {
    const keyspace = resolveCassandraKeyspaceForLoad(ctx.schema, ctx.profileId);

    let cassandraColumns = asColumnRows(prev);
    let cassandraStructure = prev.structure ?? [];
    let cassandraRowCount =
      typeof prev.rowCount === "number" ? prev.rowCount : 0;

    if (plan.needColumns || plan.needMeta || plan.needRowCount) {
      const overview = await loadCassandraOverview({
        connId: ctx.connId,
        schema: keyspace,
        tableName: ctx.tableName,
      });
      cassandraColumns = overview.columns;
      cassandraStructure = overview.structure;
      cassandraRowCount = overview.rowCount;

      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns: cassandraColumns,
          structure: cassandraStructure,
          constraints: overview.constraints,
          foreignKeys: [],
          rowCount: cassandraRowCount,
          rowCountIsEstimated: true,
          busy: false,
        }),
      });
      try {
        setColumnsCache(key, cassandraColumns);
      } catch {}
    }

    if (plan.needRows) {
      const rowsRes = await loadCassandraRows({
        key,
        connId: ctx.connId,
        schema: keyspace,
        tableName: ctx.tableName,
        limit: ctx.limit,
        offset: ctx.offset,
        resetCache: !!flags.force || !!flags.forceRows,
        forceRefresh: !!flags.forceRefresh,
      });

      if (rowsRes.columns.length > 0) {
        cassandraColumns = rowsRes.columns;
      }
      cassandraRowCount = rowsRes.rowCount || cassandraRowCount;

      patchMeta(setMeta, key, prev, {
        ...patchWithConn(ctx, {
          columns: cassandraColumns,
          rowCount: cassandraRowCount,
          rowCountIsEstimated: true,
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
