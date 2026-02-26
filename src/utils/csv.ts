/**
 * CSV serialize/parse for table data export and import.
 */

import Papa from "papaparse";
import { cellToString } from "./convert";

export type CsvExportOptions = {
  delimiter?: string;
  quoting?: "quote_if_needed" | "always" | "never";
  nullToEmpty?: boolean;
  lineBreakToSpace?: boolean;
  includeHeader?: boolean;
  decimal?: string;
  lineBreak?: string;
};

const DEFAULT_CSV_OPTIONS: Required<CsvExportOptions> = {
  delimiter: ",",
  quoting: "quote_if_needed",
  nullToEmpty: true,
  lineBreakToSpace: false,
  includeHeader: true,
  decimal: ".",
  lineBreak: "\n",
};

/** Escape a cell for CSV: wrap in quotes if needed, double internal quotes */
export function escapeCsvCell(value: unknown): string {
  const s = value == null ? "" : String(value);
  const needsQuotes = /[",\r\n]/.test(s);
  if (!needsQuotes) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

function escapeCsvCellWithOptions(
  value: unknown,
  opts: Required<CsvExportOptions>
): string {
  let s: string;
  if (value == null) {
    s = opts.nullToEmpty ? "" : "NULL";
  } else {
    s = String(value);
  }
  if (opts.lineBreakToSpace) {
    s = s.replace(/\r?\n/g, " ");
  }
  const delim = opts.delimiter;
  const needsQuotes =
    opts.quoting === "always" ||
    (opts.quoting === "quote_if_needed" &&
      new RegExp(`[${delim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\r\n]`).test(
        s
      ));
  if (!needsQuotes && opts.quoting !== "never") return s;
  return `"${s.replace(/"/g, '""')}"`;
}

/** Serialize a batch of rows to CSV (for streaming). Set addHeader true only for the first chunk. */
export function serializeCsvChunk(
  columnNames: string[],
  rows: unknown[][],
  options: CsvExportOptions = {},
  addHeader = true
): string {
  const opts = { ...DEFAULT_CSV_OPTIONS, ...options };
  const delim = opts.delimiter;
  const parts: string[] = [];
  if (addHeader && opts.includeHeader) {
    parts.push(
      columnNames.map((c) => escapeCsvCellWithOptions(c, opts)).join(delim)
    );
  }
  for (const row of rows) {
    parts.push(
      row
        .map((cell) =>
          escapeCsvCellWithOptions(cellToString(cell, !opts.nullToEmpty), opts)
        )
        .join(delim)
    );
  }
  return parts.join(opts.lineBreak);
}

/** Serialize columns + rows to CSV string (legacy; no options) */
export function serializeToCsv(
  columnNames: string[],
  rows: unknown[][]
): string {
  const header = columnNames.map(escapeCsvCell).join(",");
  const lines = rows.map((row) =>
    row.map((cell) => escapeCsvCell(cell)).join(",")
  );
  return [header, ...lines].join("\n");
}

/** Parse CSV string into rows (first row = headers, rest = data). Returns { headers, rows } */
export function parseCsv(csvText: string): {
  headers: string[];
  rows: string[][];
} {
  const parse = Papa.parse(csvText);
  const rows = parse.data;

  if (rows.length === 0) return { headers: [], rows: [] };
  const headers = rows[0] as string[];
  return { headers, rows: rows.slice(1) as string[][] };
}
