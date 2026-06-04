import { cellToString } from "src/utils/convert";
import { runRedisCommand, type TableChunk } from "src/lib/tauri";
import { DEFAULT_ROWS_CAP, useConnectionStore } from "src/stores/connection";
import type { ColumnRow } from "../types";

export async function detectRedisKeyType(connId: string, keyName: string) {
  const res = await runRedisCommand(connId, "TYPE", [keyName], {
    timeoutMs: 15_000,
  });
  return (cellToString((res.rows as unknown[][])?.[0]?.[0]) ?? "string")
    .trim()
    .toLowerCase();
}

export async function loadRedisOverview(params: {
  connId: string;
  tableName: string;
}): Promise<{
  columns: ColumnRow[];
  structure: any[];
  constraints: any[];
  rowCount: number;
  redisType: string;
}> {
  const { connId, tableName } = params;
  const redisType = await detectRedisKeyType(connId, tableName);

  const columns =
    redisType === "hash"
      ? [
          { name: "field", db_type: "redis:field" },
          { name: "value", db_type: "redis:value" },
        ]
      : [{ name: "value", db_type: `redis:${redisType || "value"}` }];

  const structure = columns.map((col) => ({
    column_name: col.name,
    data_type: col.db_type,
    is_nullable: true,
    check: "",
    column_default: "",
    comment:
      redisType === "hash"
        ? "Redis hash entry"
        : `Redis ${redisType || "value"} value`,
  }));

  return {
    columns,
    structure,
    constraints: [],
    rowCount: 0,
    redisType,
  };
}

export async function loadRedisRows(params: {
  key: string;
  connId: string;
  tableName: string;
  limit: number;
  offset: number;
  resetCache?: boolean;
}): Promise<{ columns: ColumnRow[]; rowCount: number; sizeInfo: any }> {
  const { key, connId, tableName, limit, offset, resetCache } = params;
  const redisType = await detectRedisKeyType(connId, tableName);

  let result;
  let columns: ColumnRow[] = [];

  switch (redisType) {
    case "hash":
      result = await runRedisCommand(connId, "HGETALL", [tableName], {
        timeoutMs: 20_000,
      });
      columns = [
        { name: "field", db_type: "redis:field" },
        { name: "value", db_type: "redis:value" },
      ];
      break;
    case "list":
      result = await runRedisCommand(
        connId,
        "LRANGE",
        [
          tableName,
          String(offset),
          String(Math.max(offset, offset + limit - 1)),
        ],
        { timeoutMs: 20_000 }
      );
      columns = [{ name: "value", db_type: "redis:list-item" }];
      break;
    case "set":
      result = await runRedisCommand(connId, "SMEMBERS", [tableName], {
        timeoutMs: 20_000,
      });
      columns = [{ name: "value", db_type: "redis:set-member" }];
      break;
    case "zset":
      result = await runRedisCommand(
        connId,
        "ZRANGE",
        [
          tableName,
          String(offset),
          String(Math.max(offset, offset + limit - 1)),
        ],
        { timeoutMs: 20_000 }
      );
      columns = [{ name: "value", db_type: "redis:zset-member" }];
      break;
    case "none":
      result = { columns: [], rows: [], rowCount: 0 };
      columns = [{ name: "value", db_type: "redis:value" }];
      break;
    default:
      result = await runRedisCommand(connId, "GET", [tableName], {
        timeoutMs: 20_000,
      });
      columns = [{ name: "value", db_type: `redis:${redisType || "string"}` }];
      break;
  }

  const rows = (result.rows ?? []).map((row) =>
    columns.length === 1 && row.length > 1 ? [row[row.length - 1]] : row
  );

  const store = useConnectionStore.getState();
  const opId = `redis:${key}:${offset}:${limit}`;
  const cap = Math.max(1000, limit * 4);

  store.initRows(key, DEFAULT_ROWS_CAP);
  store.beginRowsStream(key, opId, cap, offset, !!resetCache);
  store.applyRowsChunk(key, opId, {
    rows,
    row_offset: 0,
    seq: 0,
  } as TableChunk);
  store.endRowsStream(key, opId);

  return {
    columns,
    rowCount: Number(result.rowCount ?? rows.length),
    sizeInfo: {
      totalSize: "N/A",
      dataSize: redisType || "N/A",
      indexSize: "N/A",
    },
  };
}
