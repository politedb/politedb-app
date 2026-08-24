import { isSqliteLike } from "src/utils/sqliteLike";
import { cellToString, formatBytesSize } from "src/utils/convert";
import { normalizeClickhouseDbType } from "src/utils/clickhouse";
import {
  diagramTableColumnsQuery,
  tableColumnsQuery,
  tableDataQuery,
  tableOidQuery,
  tableConstraintsQuery,
  tableConstraintsMySqlQuery,
  tableForeignKeysQuery,
  tableRowCountQuery,
  tableEstimatedRowCountQuery,
  ESTIMATE_USE_EXACT_BELOW,
  tableSizeInfoQuery,
  tableStructuresQuery,
  tableStructuresMySqlQuery,
  type TableFilterCondition,
  type TableSort,
} from "src/lib/queries/sql";
import { runSqlQuery, startSqlQueryStream } from "src/lib/tauri/query";
import { operationBus } from "src/lib/tauri/operationBus";
import { operationCancel, type TableChunk } from "src/lib/tauri";
import { DEFAULT_ROWS_CAP, useConnectionStore } from "src/stores/connection";
import type { DatabaseEngine } from "src/types";
import { retryAsync } from "src/utils/common";
import {
  cellIsTruthyPrimary,
  resolveDefaultTableSort,
} from "src/utils/tableSort";
import { RETRY_ATTEMPTS } from "../constants";
import {
  inflightForeignKeysByKey,
  inflightRowCountByKey,
  inflightSizeInfoByKey,
  rowsInflightByQueryKey,
} from "../inflight";
import { getErrorMessage, isNonEmptyName, parseBusyOpId } from "../helpers";
import type { ColumnRow } from "../types";

export async function loadColumns(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
}): Promise<ColumnRow[]> {
  const { connId, schema, tableName, engine, addLogQuery } = params;
  const diagramQ = diagramTableColumnsQuery(schema, tableName, engine);
  const q = diagramQ ?? tableColumnsQuery(schema, tableName, engine);
  const res = await runSqlQuery(connId, q);
  addLogQuery(q, engine);

  return (res.rows as unknown[][])
    .map((r) => {
      const name = cellToString(r?.[0]);
      let db_type = cellToString(r?.[1]) ?? "";
      if (engine === "clickhouse") {
        db_type = normalizeClickhouseDbType(db_type, cellToString(r?.[2]));
      }
      const is_primary = diagramQ ? cellIsTruthyPrimary(r?.[2]) : undefined;
      const columnDefaultIndex = diagramQ ? 3 : engine === "clickhouse" ? 3 : 2;
      const column_default = cellToString(r?.[columnDefaultIndex], true);
      return { name, db_type, is_primary, column_default };
    })
    .filter(isNonEmptyName);
}

function resolveQueryTableSort(
  key: string,
  sortBy: TableSort | null | undefined,
  engine?: DatabaseEngine
): TableSort | null {
  if (sortBy) return sortBy;
  const meta = useConnectionStore.getState().tableDataMap[key];
  return resolveDefaultTableSort({
    columns: meta?.columns as ColumnRow[] | null | undefined,
    constraints: meta?.constraints ?? null,
    engine,
  });
}

function rowCountCacheKey(params: {
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  filters?: TableFilterCondition[];
  filterCombine?: "AND" | "OR";
  exact?: boolean;
}) {
  return JSON.stringify({
    schema: params.schema,
    table: params.tableName,
    engine: params.engine ?? "",
    exact: !!params.exact,
    combine: params.filterCombine ?? "AND",
    filters: (params.filters ?? []).map((f) => ({
      column: f.column ?? "",
      operator: f.operator ?? "",
      value: f.value ?? "",
      enabled: !!f.enabled,
    })),
  });
}

export async function loadRowCount(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
  filters?: TableFilterCondition[];
  filterCombine?: "AND" | "OR";
  exact?: boolean;
}): Promise<{ value: number; estimated: boolean }> {
  const cacheKey = rowCountCacheKey(params);
  const inflight = inflightRowCountByKey.get(cacheKey);
  if (inflight) return inflight;

  const task = loadRowCountOnce(params);
  inflightRowCountByKey.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (inflightRowCountByKey.get(cacheKey) === task) {
      inflightRowCountByKey.delete(cacheKey);
    }
  }
}

async function loadRowCountOnce(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
  filters?: TableFilterCondition[];
  filterCombine?: "AND" | "OR";
  exact?: boolean;
}): Promise<{ value: number; estimated: boolean }> {
  const {
    connId,
    schema,
    tableName,
    engine,
    addLogQuery,
    filters,
    filterCombine = "AND",
    exact = false,
  } = params;
  const hasFilters = Boolean(
    filters?.some((f) => f.enabled && (f.column ?? "").trim())
  );
  const estimatedQ =
    !exact && !hasFilters
      ? tableEstimatedRowCountQuery(schema, tableName, engine)
      : null;

  if (estimatedQ) {
    const estQ = estimatedQ;
    try {
      const estRes = await runSqlQuery(connId, estQ);
      addLogQuery(estQ, engine);
      const estimatedValue = Number(
        cellToString((estRes.rows as unknown[][])?.[0]?.[0])
      );
      if (estimatedValue < ESTIMATE_USE_EXACT_BELOW) {
        const exactQ = tableRowCountQuery(
          schema,
          tableName,
          filters,
          filterCombine,
          engine
        );
        const exactRes = await runSqlQuery(connId, exactQ);
        addLogQuery(exactQ, engine);
        return {
          value: Number(cellToString((exactRes.rows as unknown[][])?.[0]?.[0])),
          estimated: false,
        };
      }
      return { value: estimatedValue, estimated: true };
    } catch (e) {
      if (engine !== "snowflake") throw e;
    }
  }

  const q = tableRowCountQuery(
    schema,
    tableName,
    filters,
    filterCombine,
    engine
  );
  const res = await runSqlQuery(connId, q);
  addLogQuery(q, engine);
  return {
    value: Number(cellToString((res.rows as unknown[][])?.[0]?.[0])),
    estimated: false,
  };
}

export async function loadSizeInfo(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
}): Promise<{ totalSize: string; dataSize: string; indexSize: string }> {
  const cacheKey = `${params.schema}.${params.tableName}:${params.engine ?? ""}`;
  const inflight = inflightSizeInfoByKey.get(cacheKey);
  if (inflight) {
    return inflight as Promise<{
      totalSize: string;
      dataSize: string;
      indexSize: string;
    }>;
  }

  const task = loadSizeInfoOnce(params);
  inflightSizeInfoByKey.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (inflightSizeInfoByKey.get(cacheKey) === task) {
      inflightSizeInfoByKey.delete(cacheKey);
    }
  }
}

async function loadSizeInfoOnce(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
}): Promise<{ totalSize: string; dataSize: string; indexSize: string }> {
  const { connId, schema, tableName, engine, addLogQuery } = params;
  const q = tableSizeInfoQuery(schema, tableName, engine);
  let res;
  try {
    res = await runSqlQuery(connId, q);
  } catch (e) {
    if (
      engine === "snowflake" ||
      engine === "duckdb" ||
      engine === "clickhouse"
    ) {
      return { totalSize: "N/A", dataSize: "N/A", indexSize: "N/A" };
    }
    throw e;
  }
  addLogQuery(q, engine);

  const r0 = (res.rows as unknown[][])?.[0] ?? [];
  const useByteFormatter = engine !== "postgres";
  return {
    totalSize: useByteFormatter
      ? formatBytesSize(Number(cellToString(r0?.[0]) ?? 0))
      : (cellToString(r0?.[0]) ?? "0"),
    dataSize: useByteFormatter
      ? formatBytesSize(Number(cellToString(r0?.[1]) ?? 0))
      : (cellToString(r0?.[1]) ?? "0"),
    indexSize: useByteFormatter
      ? formatBytesSize(Number(cellToString(r0?.[2]) ?? 0))
      : (cellToString(r0?.[2]) ?? "0"),
  };
}

export async function loadMeta(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
}): Promise<{ structure: any[]; constraints: any[] }> {
  const { connId, schema, tableName, engine, addLogQuery } = params;

  if (isSqliteLike(engine)) {
    const qStructure = tableStructuresQuery(schema, tableName, 0, engine);
    const qConstraints = tableConstraintsQuery(schema, tableName, engine);

    const [structureRes, constraintsRes] = await Promise.all([
      runSqlQuery(connId, qStructure),
      runSqlQuery(connId, qConstraints),
    ]);

    addLogQuery(qStructure, engine);
    addLogQuery(qConstraints, engine);

    const structure = (structureRes.rows as unknown[][]).map((row) => ({
      column_name: cellToString(row?.[1]),
      data_type: cellToString(row?.[2]),
      is_nullable: cellToString(row?.[8])?.toLowerCase() === "yes",
      check: cellToString(row?.[9]) ?? "",
      column_default: cellToString(row?.[11]),
      comment: cellToString(row?.[12]) ?? "",
    }));

    const constraints = (constraintsRes.rows as unknown[][]).map((row) => ({
      index_name: cellToString(row?.[0]),
      index_algorithm: cellToString(row?.[1]) ?? "BTREE",
      is_unique: cellToString(row?.[2])?.toLowerCase() === "true",
      is_primary: cellToString(row?.[3])?.toLowerCase() === "true",
      index_definition: cellToString(row?.[4]) ?? "",
      column_name: cellToString(row?.[5]) ?? "",
      condition: "",
      include: "",
      comment: "",
    }));

    return { structure, constraints };
  }

  if (
    engine === "oracle" ||
    engine === "snowflake" ||
    engine === "clickhouse"
  ) {
    const qStructure = tableStructuresQuery(schema, tableName, 0, engine);
    const qConstraints = tableConstraintsQuery(schema, tableName, engine);

    const [structureRes, constraintsRes] = await Promise.all([
      runSqlQuery(connId, qStructure),
      runSqlQuery(connId, qConstraints),
    ]);

    addLogQuery(qStructure, engine);
    addLogQuery(qConstraints, engine);

    const structure = (structureRes.rows as unknown[][]).map((row) => ({
      column_name: cellToString(row?.[1]),
      data_type: cellToString(row?.[2]),
      is_nullable: cellToString(row?.[8])?.toLowerCase() === "yes",
      check: cellToString(row?.[9]) ?? "",
      column_default: cellToString(row?.[11]),
      comment: cellToString(row?.[12]) ?? "",
    }));

    const constraints = (constraintsRes.rows as unknown[][]).map((row) => ({
      index_name: cellToString(row?.[0]),
      index_algorithm: cellToString(row?.[1]) ?? "BTREE",
      is_unique: cellToString(row?.[2])?.toLowerCase() === "true",
      is_primary: cellToString(row?.[3])?.toLowerCase() === "true",
      index_definition: cellToString(row?.[4]) ?? "",
      column_name: cellToString(row?.[5]) ?? "",
      condition: cellToString(row?.[6]) ?? "",
      include: cellToString(row?.[7]) ?? "",
      comment: cellToString(row?.[8]) ?? "",
    }));

    return { structure, constraints };
  }

  if (engine === "mysql" || engine === "mariadb") {
    const qStructure = tableStructuresMySqlQuery(schema, tableName);
    const qConstraints = tableConstraintsMySqlQuery(schema, tableName);

    const [structureRes, constraintsRes] = await Promise.all([
      runSqlQuery(connId, qStructure),
      runSqlQuery(connId, qConstraints),
    ]);

    addLogQuery(qStructure, engine);
    addLogQuery(qConstraints, engine);

    const structure = (structureRes.rows as unknown[][]).map((row) => ({
      column_name: cellToString(row?.[1]),
      data_type: cellToString(row?.[2]),
      is_nullable: (cellToString(row?.[3]) ?? "").toLowerCase() === "yes",
      check: "",
      column_default: cellToString(row?.[4]),
      comment: cellToString(row?.[5]) ?? "",
    }));

    const constraints = (constraintsRes.rows as unknown[][]).map((row) => ({
      index_name: cellToString(row?.[0]),
      index_algorithm: cellToString(row?.[1]),
      is_unique: Number(cellToString(row?.[2]) ?? "1") === 0,
      is_primary: cellToString(row?.[3])?.toLowerCase() === "true",
      index_definition: "",
      column_name: cellToString(row?.[4]) ?? "",
      condition: "",
      include: "",
      comment: "",
    }));

    return { structure, constraints };
  }

  const qOid = tableOidQuery(schema, tableName, engine);
  const oidRes = await runSqlQuery(connId, qOid);
  addLogQuery(qOid, engine);
  const oid = Number(cellToString((oidRes.rows as unknown[][])?.[0]?.[0]));

  const qStructure = tableStructuresQuery(schema, tableName, oid, engine);
  const qConstraints = tableConstraintsQuery(schema, tableName, engine);

  const [structureRes, constraintsRes] = await Promise.all([
    runSqlQuery(connId, qStructure),
    runSqlQuery(connId, qConstraints),
  ]);

  addLogQuery(qStructure, engine);
  addLogQuery(qConstraints, engine);

  const structure = (structureRes.rows as unknown[][]).map((row) => ({
    column_name: cellToString(row?.[1]),
    data_type: cellToString(row?.[2]),
    is_nullable: cellToString(row?.[8])?.toLowerCase() === "yes",
    check: cellToString(row?.[9]),
    column_default: cellToString(row?.[11]),
    comment: cellToString(row?.[12]),
  }));

  const constraints = (constraintsRes.rows as unknown[][]).map((row) => ({
    index_name: cellToString(row?.[0]),
    index_algorithm: cellToString(row?.[1]),
    is_unique: cellToString(row?.[2])?.toLowerCase() === "true",
    is_primary: cellToString(row?.[3])?.toLowerCase() === "true",
    index_definition: cellToString(row?.[4]),
    column_name: cellToString(row?.[5]),
    condition: cellToString(row?.[6]),
    include: cellToString(row?.[7]),
    comment: cellToString(row?.[8]),
  }));

  return { structure, constraints };
}

export async function loadForeignKeys(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
}): Promise<any[]> {
  const cacheKey = `${params.schema}.${params.tableName}:${params.engine ?? ""}`;
  const inflight = inflightForeignKeysByKey.get(cacheKey);
  if (inflight) return inflight;

  const task = loadForeignKeysOnce(params);
  inflightForeignKeysByKey.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (inflightForeignKeysByKey.get(cacheKey) === task) {
      inflightForeignKeysByKey.delete(cacheKey);
    }
  }
}

async function loadForeignKeysOnce(params: {
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
}): Promise<any[]> {
  const { connId, schema, tableName, engine, addLogQuery } = params;

  if (
    engine === "mysql" ||
    engine === "mariadb" ||
    engine === "snowflake" ||
    engine === "clickhouse" ||
    isSqliteLike(engine)
  ) {
    return [];
  }

  const qFk = tableForeignKeysQuery(schema, tableName, engine);
  const fkRes = await runSqlQuery(connId, qFk);
  addLogQuery(qFk, engine);

  return (fkRes.rows as unknown[][]).map((row) => ({
    constraint_name: cellToString(row?.[0]),
    table_schema: cellToString(row?.[1]),
    table_name: cellToString(row?.[2]),
    column_names: cellToString(row?.[3]),
    ref_table_schema: cellToString(row?.[4]),
    ref_table_name: cellToString(row?.[5]),
    ref_column_names: cellToString(row?.[6]),
    on_update: cellToString(row?.[7]) || "NO ACTION",
    on_delete: cellToString(row?.[8]) || "NO ACTION",
  }));
}

export async function startRowsStream(params: {
  key: string;
  connId: string;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  limit: number;
  offset: number;
  addLogQuery: (sql: string, engine?: DatabaseEngine) => void;
  resetCache?: boolean;
  forceRefresh?: boolean;
  filters?: TableFilterCondition[];
  filterCombine?: "AND" | "OR";
  sortBy?: TableSort | null;
}): Promise<void> {
  const {
    key,
    connId,
    schema,
    tableName,
    engine,
    limit,
    offset,
    addLogQuery,
    resetCache,
    forceRefresh,
    filters,
    filterCombine = "AND",
    sortBy,
  } = params;

  const querySort = resolveQueryTableSort(key, sortBy, engine);

  const q = tableDataQuery(
    schema,
    tableName,
    { limit, offset },
    filters,
    filterCombine,
    querySort,
    engine
  );

  if (!forceRefresh) {
    const inflight = rowsInflightByQueryKey.get(q);
    if (inflight) return inflight;
  }

  const streamTask = (async () => {
    addLogQuery(q, engine);

    const store = useConnectionStore.getState();

    store.initRows(key, DEFAULT_ROWS_CAP);

    const old = store.getRowsWindowInfo(key);
    const oldOpId = old?.opId;
    if (oldOpId) {
      try {
        await operationCancel(oldOpId);
      } catch {}
    }

    const rowsOpId = await retryAsync(
      () =>
        startSqlQueryStream(connId, q, {
          batchSize: 200,
          maxRows: limit,
        }),
      {
        attempts: RETRY_ATTEMPTS,
        shouldRetry: (err) => Boolean(parseBusyOpId(err)),
        onRetry: async (err) => {
          const busyOpId = parseBusyOpId(err);
          if (!busyOpId) return;

          try {
            await operationCancel(busyOpId);
          } catch {}
        },
        delayMs: (attempt) => 40 * attempt,
      }
    );

    const cap = Math.max(1000, limit * 4);

    store.beginRowsStream(key, rowsOpId, cap, offset, resetCache, forceRefresh);

    let unsub: (() => void) | null = null;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        try {
          unsub?.();
        } catch {}
        unsub = null;
        fn();
      };

      void operationBus
        .subscribe(rowsOpId, {
          onChunk: (chunk: TableChunk) => {
            useConnectionStore.getState().applyRowsChunk(key, rowsOpId, chunk);
          },
          onDone: () => {
            const cur = useConnectionStore.getState().getRowsWindowInfo(key);
            if (!cur || cur.opId !== rowsOpId) {
              finish(resolve);
              return;
            }
            useConnectionStore.getState().endRowsStream(key, rowsOpId);
            finish(resolve);
          },
          onError: (err: unknown) => {
            const cur = useConnectionStore.getState().getRowsWindowInfo(key);
            if (!cur || cur.opId !== rowsOpId) {
              finish(() => reject(err));
              return;
            }
            useConnectionStore
              .getState()
              .failRowsStream(key, rowsOpId, getErrorMessage(err));
            finish(() => reject(err));
          },
        })
        .then((unsubFn) => {
          unsub = unsubFn;
        })
        .catch((err) => finish(() => reject(err)));
    });
  })();

  rowsInflightByQueryKey.set(q, streamTask);
  try {
    await streamTask;
  } finally {
    if (rowsInflightByQueryKey.get(q) === streamTask) {
      rowsInflightByQueryKey.delete(q);
    }
  }
}
