import { useConnectionStore } from "src/stores/connection";
import { latestLoadSignatureByKey } from "../inflight";
import { getErrorMessage } from "../helpers";
import { patchMeta } from "../metaPatch";
import {
  loadColumns,
  loadForeignKeys,
  loadMeta,
  loadRowCount,
  loadSizeInfo,
  startRowsStream,
} from "../loaders/sqlLoader";
import type { LoadExecutionContext, LoadExecutionResult } from "./types";

export async function executeSqlLoad(
  ctx: LoadExecutionContext
): Promise<LoadExecutionResult> {
  const {
    key,
    loadSignature,
    schema,
    tableName,
    connId,
    plan,
    prev,
    flags,
    engine,
    supportsMeta,
    columnsCache,
    sizeInfoCache,
    setMeta,
    setColumnsCache,
    setSizeInfoCache,
    addLogQuery,
  } = ctx;

  const cachedCols = columnsCache[key];
  if (
    (!Array.isArray(prev.columns) || prev.columns.length === 0) &&
    Array.isArray(cachedCols) &&
    cachedCols.length > 0
  ) {
    patchMeta(setMeta, key, prev, { columns: cachedCols });
  }

  const cachedSize = sizeInfoCache[key];
  if (!prev.sizeInfo && cachedSize) {
    patchMeta(setMeta, key, prev, { sizeInfo: cachedSize });
  }

  if (plan.needColumns) {
    try {
      const columns = await loadColumns({
        connId,
        schema,
        tableName,
        engine,
        addLogQuery,
      });

      const curPrev = useConnectionStore.getState().tableDataMap[key] ?? prev;

      patchMeta(setMeta, key, curPrev, {
        columns,
        connectionId: curPrev.connectionId ?? connId,
      });

      try {
        setColumnsCache(key, columns);
      } catch {}
    } catch (e) {
      patchMeta(setMeta, key, prev, {
        busy: false,
        error: getErrorMessage(e),
      });
      return "done";
    }
  }

  let rowsPromise: Promise<void> | undefined;
  if (plan.needRows) {
    const shouldReset = !!flags.force || !!flags.forceRows;
    rowsPromise = startRowsStream({
      key,
      connId,
      schema,
      tableName,
      engine,
      limit: ctx.limit,
      offset: ctx.offset,
      addLogQuery,
      resetCache: shouldReset,
      forceRefresh: !!flags.forceRefresh,
      filters: flags.filters,
      filterCombine: flags.filterCombine ?? "AND",
      sortBy: flags.sortBy ?? null,
    }).catch((e) => {
      const curMeta = useConnectionStore.getState().tableDataMap[key] ?? prev;
      patchMeta(setMeta, key, curMeta, {
        busy: false,
        error: getErrorMessage(e),
      });
      throw e;
    });
  }

  const metaTasks: Promise<void>[] = [];

  if (plan.needRowCount) {
    metaTasks.push(
      (async () => {
        const rowCount = await loadRowCount({
          connId,
          schema,
          tableName,
          engine,
          addLogQuery,
          filters: flags.filters,
          filterCombine: flags.filterCombine ?? "AND",
          exact: !!flags.exactRowCount,
        });
        if (latestLoadSignatureByKey.get(key) !== loadSignature) return;
        patchMeta(setMeta, key, prev, {
          rowCount: rowCount.value,
          rowCountIsEstimated: rowCount.estimated,
        });
      })()
    );
  }

  if (plan.needSizeInfo) {
    metaTasks.push(
      (async () => {
        const sizeInfo = await loadSizeInfo({
          connId,
          schema,
          tableName,
          engine,
          addLogQuery,
        });
        if (latestLoadSignatureByKey.get(key) !== loadSignature) return;
        patchMeta(setMeta, key, prev, { sizeInfo });
        try {
          setSizeInfoCache(key, sizeInfo);
        } catch {}
      })()
    );
  }

  if (plan.needMeta && supportsMeta) {
    metaTasks.push(
      (async () => {
        const { structure, constraints } = await loadMeta({
          connId,
          schema,
          tableName,
          engine,
          addLogQuery,
        });
        if (latestLoadSignatureByKey.get(key) !== loadSignature) return;
        patchMeta(setMeta, key, prev, {
          structure,
          constraints,
        });
      })()
    );
  }

  if (plan.needForeignKeys && supportsMeta && engine !== "snowflake") {
    metaTasks.push(
      (async () => {
        const foreignKeys = await loadForeignKeys({
          connId,
          schema,
          tableName,
          engine,
          addLogQuery,
        });
        if (latestLoadSignatureByKey.get(key) !== loadSignature) return;
        patchMeta(setMeta, key, prev, { foreignKeys });
      })()
    );
  } else if (plan.needForeignKeys && engine === "snowflake") {
    patchMeta(setMeta, key, prev, { foreignKeys: [] });
  }

  const settleTasks = rowsPromise ? [...metaTasks, rowsPromise] : metaTasks;

  if (settleTasks.length === 0) {
    if (plan.needAnyMetaWork) {
      patchMeta(setMeta, key, prev, { busy: false });
    }
    return "done";
  }

  const results = await Promise.allSettled(settleTasks);
  const firstErr = results.find((r) => r.status === "rejected") as
    | PromiseRejectedResult
    | undefined;

  if (firstErr) {
    patchMeta(setMeta, key, prev, {
      busy: false,
      error: getErrorMessage(firstErr.reason),
    });
    return "done";
  }

  patchMeta(setMeta, key, prev, { busy: false });
  return "done";
}
