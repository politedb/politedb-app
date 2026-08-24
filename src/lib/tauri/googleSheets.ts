import { invoke } from "@tauri-apps/api/core";

import { CMD } from "./commands";
import type { ColumnMeta, QueryResult } from "./types";

export type GoogleSheetInfo = {
  title: string;
  row_count: number;
  column_count: number;
};

export type GoogleSheetsMetadata = {
  spreadsheet_title: string;
  sheets: GoogleSheetInfo[];
};

export type GoogleSheetOverview = {
  columns: ColumnMeta[];
  row_count: number;
};

export function googleSheetsListSheets(
  connectionId: string
): Promise<GoogleSheetsMetadata> {
  return invoke<GoogleSheetsMetadata>(CMD.googleSheetsListSheets, {
    connectionId,
  });
}

export function googleSheetsSheetOverview(args: {
  connectionId: string;
  sheet: string;
}): Promise<GoogleSheetOverview> {
  return invoke<GoogleSheetOverview>(CMD.googleSheetsSheetOverview, args);
}

export async function googleSheetsFetchRows(args: {
  connectionId: string;
  sheet: string;
  limit: number;
  offset: number;
}): Promise<QueryResult> {
  const result = await invoke<{
    columns: QueryResult["columns"];
    rows: QueryResult["rows"];
    row_count: number;
  }>(CMD.googleSheetsFetchRows, args);
  return {
    columns: result.columns ?? [],
    rows: result.rows ?? [],
    rowCount: Number(result.row_count ?? 0),
  };
}
