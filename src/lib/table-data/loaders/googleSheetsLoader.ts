import {
  googleSheetsFetchRows,
  googleSheetsSheetOverview,
  type TableChunk,
} from "src/lib/tauri";
import { DEFAULT_ROWS_CAP, useConnectionStore } from "src/stores/connection";
import type { ColumnRow } from "../types";

export async function loadGoogleSheetsOverview(params: {
  connId: string;
  tableName: string;
}): Promise<{
  columns: ColumnRow[];
  structure: any[];
  rowCount: number;
}> {
  const overview = await googleSheetsSheetOverview({
    connectionId: params.connId,
    sheet: params.tableName,
  });
  const columns = overview.columns.map((column) => ({
    name: column.name,
    db_type: column.db_type,
  }));
  return {
    columns,
    structure: columns.map((column) => ({
      column_name: column.name,
      data_type: column.db_type,
      is_nullable: true,
      check: "",
      column_default: "",
      comment: "",
    })),
    rowCount: Number(overview.row_count ?? 0),
  };
}

export async function loadGoogleSheetsRows(params: {
  key: string;
  connId: string;
  tableName: string;
  limit: number;
  offset: number;
  resetCache?: boolean;
  forceRefresh?: boolean;
}): Promise<{ columns: ColumnRow[]; rowCount: number }> {
  const result = await googleSheetsFetchRows({
    connectionId: params.connId,
    sheet: params.tableName,
    limit: params.limit,
    offset: params.offset,
  });
  const store = useConnectionStore.getState();
  const opId = `google-sheets:${params.key}:${params.offset}:${params.limit}`;
  store.initRows(params.key, DEFAULT_ROWS_CAP);
  store.beginRowsStream(
    params.key,
    opId,
    Math.max(1_000, params.limit * 4),
    params.offset,
    !!params.resetCache,
    !!params.forceRefresh
  );
  store.applyRowsChunk(params.key, opId, {
    rows: result.rows ?? [],
    row_offset: 0,
    seq: 0,
  } as TableChunk);
  store.endRowsStream(params.key, opId);
  return {
    columns: result.columns.map((column) => ({
      name: column.name,
      db_type: column.db_type,
    })),
    rowCount: result.rowCount,
  };
}
