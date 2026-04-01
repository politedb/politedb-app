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

export async function mongoListIndexes(args: {
  connectionId: string;
  database?: string | null;
  collection: string;
}): Promise<
  Array<{
    index_name: string;
    index_algorithm: string;
    is_unique: boolean;
    is_primary: boolean;
    column_name: string;
    index_definition: string;
  }>
> {
  return invoke(CMD.mongoListIndexes, {
    connectionId: args.connectionId,
    database: args.database ?? null,
    collection: args.collection,
  });
}

export async function mongoCollectionSizeInfo(args: {
  connectionId: string;
  database?: string | null;
  collection: string;
}): Promise<{
  total_size_bytes: number;
  data_size_bytes: number;
  index_size_bytes: number;
}> {
  return invoke(CMD.mongoCollectionSizeInfo, {
    connectionId: args.connectionId,
    database: args.database ?? null,
    collection: args.collection,
  });
}

export async function mongoInsertDocuments(args: {
  connectionId: string;
  database?: string | null;
  collection: string;
  documents: Array<Record<string, unknown>>;
}): Promise<number> {
  return invoke<number>(CMD.mongoInsertDocuments, {
    connectionId: args.connectionId,
    database: args.database ?? null,
    collection: args.collection,
    documents: args.documents ?? [],
  });
}

export async function mongoUpdateDocuments(args: {
  connectionId: string;
  database?: string | null;
  collection: string;
  updates: Array<{ id: unknown; set: Record<string, unknown> }>;
}): Promise<number> {
  return invoke<number>(CMD.mongoUpdateDocuments, {
    connectionId: args.connectionId,
    database: args.database ?? null,
    collection: args.collection,
    updates: args.updates ?? [],
  });
}

export async function mongoDeleteDocuments(args: {
  connectionId: string;
  database?: string | null;
  collection: string;
  ids: unknown[];
}): Promise<number> {
  return invoke<number>(CMD.mongoDeleteDocuments, {
    connectionId: args.connectionId,
    database: args.database ?? null,
    collection: args.collection,
    ids: args.ids ?? [],
  });
}
