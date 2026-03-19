import { invoke } from "@tauri-apps/api/core";

import { CMD } from "./commands";
import type { MongoCollectionOverview, QueryResult } from "./types";

export async function mongoListDatabases(
  connectionId: string
): Promise<string[]> {
  return invoke<string[]>(CMD.mongoListDatabases, {
    connectionId,
  });
}

export async function mongoListCollections(
  connectionId: string,
  database?: string | null
): Promise<string[]> {
  return invoke<string[]>(CMD.mongoListCollections, {
    connectionId,
    database: database ?? null,
  });
}

export async function mongoCollectionOverview(args: {
  connectionId: string;
  database?: string | null;
  collection: string;
  sampleSize?: number;
}): Promise<MongoCollectionOverview> {
  return invoke<MongoCollectionOverview>(CMD.mongoCollectionOverview, {
    connectionId: args.connectionId,
    database: args.database ?? null,
    collection: args.collection,
    sample_size: args.sampleSize ?? null,
  });
}

export async function mongoFindDocuments(args: {
  connectionId: string;
  database?: string | null;
  collection: string;
  limit?: number;
  offset?: number;
}): Promise<QueryResult> {
  const res = await invoke<{
    columns: QueryResult["columns"];
    rows: QueryResult["rows"];
    row_count: number;
  }>(CMD.mongoFindDocuments, {
    connectionId: args.connectionId,
    database: args.database ?? null,
    collection: args.collection,
    limit: args.limit ?? null,
    offset: args.offset ?? null,
  });

  return {
    columns: res.columns ?? [],
    rows: res.rows ?? [],
    rowCount: Number(res.row_count ?? 0),
  };
}
