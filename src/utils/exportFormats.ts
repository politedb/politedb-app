/**
 * Streaming export formatters for JSON and SQL.
 * CSV chunk formatting is in csv.ts (serializeCsvChunk).
 */

import { cellToString } from "./convert";
import type { DatabaseEngine } from "src/types";
import { formatSqlValue, quoteIdentifier, quoteTableName } from "./sqlDialect";

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

/** Format rows as one INSERT statement per chunk (for streaming). */
export function formatSqlChunk(
  schema: string,
  tableName: string,
  columnNames: string[],
  rows: unknown[][],
  engine: DatabaseEngine = "postgres"
): string {
  if (rows.length === 0) return "";
  const tableIdent = quoteTableName(schema, tableName, engine);
  const colList = columnNames
    .map((name) => quoteIdentifier(name, engine))
    .join(", ");
  const values = rows
    .map(
      (row) =>
        `  (${row.map((cell) => formatSqlValue(cellToString(cell, true), undefined, engine)).join(", ")})`
    )
    .join(",\n");
  return `INSERT INTO ${tableIdent} (${colList}) VALUES\n\t${values};\n`;
}
