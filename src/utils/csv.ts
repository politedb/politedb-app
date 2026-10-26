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

/**
 * Split CSV text into records with the import's own rules, so the preview
 * shows exactly what the import inserts (src-tauri csv_import.rs
 * `parse_csv_text`): a leading BOM is dropped; LF, CRLF and CR end a
 * record; a quote only starts a quoted value at the start of a field
 * (elsewhere it is an ordinary character); inside quotes a doubled quote is
 * a quote; anything but a separator or line end after a closing quote is
 * an error; a line with nothing on it is skipped (a quoted empty value
 * `""` is a record); an unterminated quote is an error.
 */
export function parseCsvRecords(text: string, delimiter: string): string[][] {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  let fieldStart = true;
  let afterClose = false;
  let rowQuoted = false;

  const endRecord = () => {
    row.push(cell);
    cell = "";
    const blankLine = row.length === 1 && row[0] === "" && !rowQuoted;
    if (!blankLine) rows.push(row);
    row = [];
    rowQuoted = false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
          afterClose = true;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"' && fieldStart) {
      inQuotes = true;
      rowQuoted = true;
      fieldStart = false;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = "";
      fieldStart = true;
      afterClose = false;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i += 1;
      endRecord();
      fieldStart = true;
      afterClose = false;
    } else if (afterClose) {
      throw new Error(
        `Unexpected text after a closing quote in record ${rows.length + 1} of the CSV file.`
      );
    } else {
      cell += ch;
      fieldStart = false;
    }
  }

  if (inQuotes) throw new Error("Unterminated quoted field in the CSV file.");
  if (cell !== "" || row.length > 0 || rowQuoted) endRecord();
  return rows;
}

/** The likely separator of a CSV text: comma, semicolon, tab or pipe. */
export function guessCsvDelimiter(text: string): string {
  const sample = text.slice(0, 64 * 1024);
  const guess = Papa.parse<string[]>(sample, {
    delimitersToGuess: [",", ";", "\t", "|"],
    preview: 20,
    skipEmptyLines: true,
  }).meta.delimiter;
  return [",", ";", "\t", "|"].includes(guess) ? guess : ",";
}

/**
 * Parse CSV text into rows (first row = headers, rest = data), split the
 * way the import will split it. Without a delimiter one is guessed; the
 * one used is returned so the import receives the same.
 */
export function parseCsv(
  csvText: string,
  delimiter?: string
): {
  headers: string[];
  rows: string[][];
  delimiter: string;
} {
  const used = delimiter || guessCsvDelimiter(csvText);
  const rows = parseCsvRecords(csvText, used);
  if (rows.length === 0) return { headers: [], rows: [], delimiter: used };
  return { headers: rows[0]!, rows: rows.slice(1), delimiter: used };
}
