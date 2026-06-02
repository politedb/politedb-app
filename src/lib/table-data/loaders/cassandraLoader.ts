import { useProfileStore } from "src/stores/profile";
import {
  cassandraFetchRows,
  cassandraTableOverview,
  type TableChunk,
} from "src/lib/tauri";
import { DEFAULT_ROWS_CAP, useConnectionStore } from "src/stores/connection";
import type { ColumnRow } from "../types";

export function resolveCassandraKeyspaceForLoad(
  schema: string,
  profileId: string
): string {
  const fromSchema = schema?.trim();
  if (fromSchema && fromSchema !== "default") return fromSchema;

  const profile = useProfileStore.getState().getProfileById(profileId);
  const fromProfile = profile?.input?.cassandra?.keyspace?.trim();
  if (fromProfile) return fromProfile;

  throw new Error(
    "Cassandra keyspace is required. Set keyspace in the connection or choose one with the database icon."
  );
}

export async function loadCassandraOverview(params: {
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
  const overview = await cassandraTableOverview({
    connectionId: connId,
    keyspace: schema,
    table: tableName,
  });

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

  return {
    columns,
    structure,
    constraints: [],
    rowCount: Number(overview.row_count ?? 0),
  };
}

export async function loadCassandraRows(params: {
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

  const result = await cassandraFetchRows({
    connectionId: connId,
    keyspace: schema,
    table: tableName,
    limit,
    offset,
  });

  const store = useConnectionStore.getState();
  const opId = `cassandra:${key}:${offset}:${limit}`;
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
