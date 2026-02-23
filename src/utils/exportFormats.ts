/**
 * Streaming export formatters for JSON and SQL.
 * CSV chunk formatting is in csv.ts (serializeCsvChunk).
 */

import { cellToString } from "./convert";

/** Format rows as JSON array items (with leading comma when not first). */
export function formatJsonChunk(
  columnNames: string[],
  rows: unknown[][],
  isFirstChunk: boolean,
  nullToEmpty: boolean = false
): string {
  if (rows.length === 0) return "";
  const lines: string[] = [];
  for (const row of rows) {
    const obj: Record<string, unknown> = {};
    columnNames.forEach((name, i) => {
      const v = row[i];
      obj[name] = cellToString(v, !nullToEmpty);
    });
    const json = JSON.stringify(obj);
    lines.push((isFirstChunk && lines.length === 0 ? "" : ",") + json);
  }
  return lines.join("\n");
}

/** Escape a value for SQL literal (single-quoted, internal quotes doubled). */
function sqlEscape(value: unknown): string {
  if (value == null) return "NULL";
  const s = String(value);
  return `'${s.replace(/'/g, "''").replace(/\\/g, "\\\\")}'`;
}

/** Format rows as one INSERT statement per chunk (for streaming). */
export function formatSqlChunk(
  schema: string,
  tableName: string,
  columnNames: string[],
  rows: unknown[][]
): string {
  if (rows.length === 0) return "";
  const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
  const tableIdent = `${q(schema)}.${q(tableName)}`;
  const colList = columnNames.map(q).join(", ");
  const values = rows
    .map(
      (row) =>
        `  (${row.map((cell) => sqlEscape(cellToString(cell, true))).join(", ")})`
    )
    .join(",\n");
  return `INSERT INTO ${tableIdent} (${colList}) VALUES\n\t${values};\n`;
}
