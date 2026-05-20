import { invoke } from "@tauri-apps/api/core";

import { CMD } from "./commands";
import type { MongoCollectionOverview, QueryResult } from "./types";

export async function cassandraListKeyspaces(
  connectionId: string
): Promise<string[]> {
  return invoke<string[]>(CMD.cassandraListKeyspaces, {
    connectionId,
  });
}

export async function cassandraListTables(
  connectionId: string,
  keyspace?: string | null
): Promise<string[]> {
  return invoke<string[]>(CMD.cassandraListTables, {
    connectionId,
    keyspace: keyspace ?? null,
  });
}

export async function cassandraTableOverview(args: {
  connectionId: string;
  keyspace?: string | null;
  table: string;
}): Promise<MongoCollectionOverview> {
  return invoke<MongoCollectionOverview>(CMD.cassandraTableOverview, {
    connectionId: args.connectionId,
    keyspace: args.keyspace ?? null,
    table: args.table,
  });
}

export async function cassandraFetchRows(args: {
  connectionId: string;
  keyspace?: string | null;
  table: string;
  limit?: number;
  offset?: number;
}): Promise<QueryResult> {
  const res = await invoke<{
    columns: QueryResult["columns"];
    rows: QueryResult["rows"];
    row_count: number;
  }>(CMD.cassandraFetchRows, {
    connectionId: args.connectionId,
    keyspace: args.keyspace ?? null,
    table: args.table,
    limit: args.limit ?? null,
    offset: args.offset ?? null,
  });

  return {
    columns: res.columns ?? [],
    rows: res.rows ?? [],
    rowCount: Number(res.row_count ?? 0),
  };
}

export async function cassandraPrimaryKeyColumns(args: {
  connectionId: string;
  keyspace?: string | null;
  table: string;
}): Promise<string[]> {
  return invoke<string[]>(CMD.cassandraPrimaryKeyColumns, {
    connectionId: args.connectionId,
    keyspace: args.keyspace ?? null,
    table: args.table,
  });
}

export async function cassandraUpdateRows(args: {
  connectionId: string;
  keyspace?: string | null;
  table: string;
  updates: Array<{
    pk: Record<string, string>;
    set: Record<string, string>;
  }>;
}): Promise<number> {
  return invoke<number>(CMD.cassandraUpdateRows, {
    connectionId: args.connectionId,
    keyspace: args.keyspace ?? null,
    table: args.table,
    updates: args.updates ?? [],
  });
}
