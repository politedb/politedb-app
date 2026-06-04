import { formatBytesSize } from "src/utils/convert";
import {
  mongoCollectionOverview,
  mongoCollectionSizeInfo,
  mongoFindDocuments,
  mongoListIndexes,
  type TableChunk,
} from "src/lib/tauri";
import { DEFAULT_ROWS_CAP, useConnectionStore } from "src/stores/connection";
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

export async function loadMongoRows(params: {
  key: string;
  connId: string;
  schema: string;
  tableName: string;
  limit: number;
  offset: number;
  resetCache?: boolean;
  forceRefresh?: boolean;
}): Promise<{ columns: ColumnRow[]; rowCount: number }> {
  const {
    key,
    connId,
    schema,
    tableName,
    limit,
    offset,
    resetCache,
    forceRefresh,
  } = params;
  const result = await mongoFindDocuments({
    connectionId: connId,
    database: schema,
    collection: tableName,
    limit,
    offset,
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
  };
}
