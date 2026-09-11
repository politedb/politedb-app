import { formatBytesSize } from "src/utils/convert";
import {
  mongoCollectionOverview,
  mongoCollectionSizeInfo,
  mongoFindDocuments,
  mongoListIndexes,
  type TableChunk,
} from "src/lib/tauri";
import {
  buildMongoFilter,
  buildMongoSort,
  formatMongoFindPreview,
} from "src/lib/queries/mongo";
import type { TableFilterCondition, TableSort } from "src/lib/queries/sql";
import { DEFAULT_ROWS_CAP, useConnectionStore } from "src/stores/connection";
import type { DatabaseEngine } from "src/types";
import type { ColumnRow } from "../types";

export async function loadMongoOverview(params: {
  connId: string;
  schema: string;
  tableName: string;
}): Promise<{
  columns: ColumnRow[];
  structure: any[];
  constraints: any[];
  rowCount: number;
}> {
  const { connId, schema, tableName } = params;
  const [overview, indexes] = await Promise.all([
    mongoCollectionOverview({
      connectionId: connId,
      database: schema,
      collection: tableName,
      sampleSize: 100,
    }),
    mongoListIndexes({
      connectionId: connId,
      database: schema,
      collection: tableName,
    }),
  ]);

  const columns = (overview.columns ?? []).map((col) => ({
    name: col.name,
    db_type: col.db_type,
  }));

  const structure = columns.map((col) => ({
    column_name: col.name,
    data_type: col.db_type,
    is_nullable: true,
    check: "",
    column_default: "",
    comment: "",
  }));

  const constraints = (indexes ?? []).map((idx) => ({
    index_name: idx.index_name ?? "",
    index_algorithm: idx.index_algorithm ?? "",
    is_unique: !!idx.is_unique,
    is_primary: !!idx.is_primary,
    index_definition: idx.index_definition ?? "",
    column_name: idx.column_name ?? "",
    condition: "",
    include: "",
    comment: "",
  }));

  return {
    columns,
    structure,
    constraints,
    rowCount: Number(overview.row_count ?? 0),
  };
}

export async function loadMongoSizeInfo(params: {
  connId: string;
  schema: string;
  tableName: string;
}): Promise<{ totalSize: string; dataSize: string; indexSize: string }> {
  const { connId, schema, tableName } = params;
  const stats = await mongoCollectionSizeInfo({
    connectionId: connId,
    database: schema,
    collection: tableName,
  });

  return {
    totalSize: formatBytesSize(stats.total_size_bytes ?? 0),
    dataSize: formatBytesSize(stats.data_size_bytes ?? 0),
    indexSize: formatBytesSize(stats.index_size_bytes ?? 0),
  };
}

export async function loadMongoRowCount(params: {
  connId: string;
  schema: string;
  tableName: string;
  filters?: TableFilterCondition[];
  filterCombine?: "AND" | "OR";
  addLogQuery?: (sql: string, engine?: DatabaseEngine) => void;
}): Promise<{ rowCount: number; estimated: boolean }> {
  const { connId, schema, tableName, filters, filterCombine, addLogQuery } =
    params;
  const filter = buildMongoFilter(filters, filterCombine ?? "AND");
  addLogQuery?.(
    formatMongoFindPreview({
      collection: tableName,
      filters,
      combine: filterCombine,
    }) + ".count()",
    "mongo"
  );
  const result = await mongoFindDocuments({
    connectionId: connId,
    database: schema,
    collection: tableName,
    limit: 0,
    offset: 0,
    filter,
    exactCount: true,
  });
  return {
    rowCount: Number(result.rowCount ?? 0),
    estimated: !!result.rowCountIsEstimated,
  };
}

export async function loadMongoRows(params: {
  key: string;
  connId: string;
  schema: string;
  tableName: string;
  limit: number;
  offset: number;
  resetCache?: boolean;
  forceRefresh?: boolean;
  filters?: TableFilterCondition[];
  filterCombine?: "AND" | "OR";
  sortBy?: TableSort | null;
  exactCount?: boolean;
  addLogQuery?: (sql: string, engine?: DatabaseEngine) => void;
}): Promise<{
  columns: ColumnRow[];
  rowCount: number;
  rowCountIsEstimated: boolean;
}> {
  const {
    key,
    connId,
    schema,
    tableName,
    limit,
    offset,
    resetCache,
    forceRefresh,
    filters,
    filterCombine,
    sortBy,
    exactCount,
    addLogQuery,
  } = params;
  const filter = buildMongoFilter(filters, filterCombine ?? "AND");
  const sort = buildMongoSort(sortBy);
  addLogQuery?.(
    formatMongoFindPreview({
      collection: tableName,
      filters,
      combine: filterCombine,
      sortBy,
      limit,
      offset,
    }),
    "mongo"
  );
  const result = await mongoFindDocuments({
    connectionId: connId,
    database: schema,
    collection: tableName,
    limit,
    offset,
    filter,
    sort,
    exactCount: !!exactCount || Object.keys(filter).length > 0,
  });

  const store = useConnectionStore.getState();
  const opId = `mongo:${key}:${offset}:${limit}`;
  const cap = Math.max(1000, limit * 4);

  store.initRows(key, DEFAULT_ROWS_CAP);
  store.beginRowsStream(key, opId, cap, offset, !!resetCache, !!forceRefresh);
  store.applyRowsChunk(key, opId, {
    rows: result.rows ?? [],
    row_offset: 0,
    seq: 0,
  } as TableChunk);
  store.endRowsStream(key, opId);

  return {
    columns: (result.columns ?? []).map((col) => ({
      name: col.name,
      db_type: col.db_type,
    })),
    rowCount: Number(result.rowCount ?? 0),
    rowCountIsEstimated: !!result.rowCountIsEstimated,
  };
}
