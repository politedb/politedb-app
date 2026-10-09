import { serializeCsvChunk, type CsvExportOptions } from "src/utils/csv";
import {
  formatJsonChunk,
  formatSqlChunk,
} from "src/lib/export-pipeline/exportFormats";
import { cellToString } from "src/utils/convert";
import type { DatabaseEngine } from "src/types";
import type { MaskingPolicy } from "src/lib/export-masking";
import { isNullCell, REDACTED_TEXT } from "src/lib/export-masking";
import type { ExportFormat } from "./types";

function maskedJsonValue(
  cell: unknown,
  rule: string,
  nullToEmpty: boolean
): unknown {
  if (rule === "set_null") return null;
  if (rule === "redact") {
    if (isNullCell(cell)) return null;
    return REDACTED_TEXT;
  }
  return cellToString(cell, !nullToEmpty);
}

export function formatMaskedJsonChunk(
  policy: MaskingPolicy,
  columns: string[],
  rows: unknown[][],
  isFirstChunk: boolean,
  nullToEmpty: boolean
): string {
  if (rows.length === 0) return "";
  const lines: string[] = [];
  for (const row of rows) {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const name = columns[i]!;
      const rule = policy.rulesByColumn[name] ?? "redact";
      obj[name] = maskedJsonValue(row[i], rule, nullToEmpty);
    }
    const json = JSON.stringify(obj);
    lines.push((isFirstChunk && lines.length === 0 ? "" : ",") + json);
  }
  return lines.join("\n");
}

/** Match runStreamingExport call site. */
export function serializeExportChunk(args: {
  format: ExportFormat;
  columns: string[];
  rows: unknown[][];
  isFirstChunk: boolean;
  csvOptions: CsvExportOptions;
  preserveJsonNulls: boolean;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  /** Optional policy for masked JSON value rules. */
  policy?: MaskingPolicy | null;
}): string {
  const {
    format,
    columns,
    rows,
    isFirstChunk,
    csvOptions,
    preserveJsonNulls,
    schema,
    tableName,
    engine,
    policy,
  } = args;

  if (format === "csv") {
    return serializeCsvChunk(columns, rows, csvOptions, isFirstChunk);
  }
  if (format === "json") {
    if (preserveJsonNulls && policy) {
      const part = formatMaskedJsonChunk(
        policy,
        columns,
        rows,
        isFirstChunk,
        false
      );
      return (isFirstChunk ? "[" : "") + part;
    }
    const part = formatJsonChunk(
      columns,
      rows,
      isFirstChunk,
      !preserveJsonNulls
    );
    return (isFirstChunk ? "[" : "") + part;
  }
  return formatSqlChunk(schema, tableName, columns, rows, engine);
}

export function serializeExportTrailer(args: {
  format: ExportFormat;
  totalExported: number;
  columns: string[];
  csvOptions: CsvExportOptions;
}): string {
  const { format, totalExported, columns, csvOptions } = args;
  if (format === "json") {
    return totalExported > 0 ? "]" : "[]";
  }
  if (format === "csv" && totalExported === 0) {
    return serializeCsvChunk(columns, [], csvOptions, true);
  }
  return "";
}
