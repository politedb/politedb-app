import { useCallback, useRef, useState } from "preact/hooks";
import { openDialog } from "src/lib/system-dialog";
import { readTextFile } from "src/lib/system-fs";
import { parseCsv } from "src/utils/csv";
import { operationImportCsvTransaction } from "src/lib/tauri";
import type { ColumnMeta } from "src/lib/tauri/types";
import type { DatabaseEngine, TableStructure } from "src/types";
import { parseNullable } from "src/lib/sql/columnFlags";
import { showMessage } from "src/lib/system-dialog";

export type DataImportPreview = {
  headers: string[];
  rows: string[][];
};

export type ImportColumnMapping = Record<string, number | null>;
export type ImportNullMode = "empty-string" | "empty-as-null";

export type ImportIssue = {
  row: number;
  column: string;
  value: string;
  message: string;
};

export type ImportOptions = {
  firstIsHeaders: boolean;
  columnMapping: ImportColumnMapping;
  nullMode: ImportNullMode;
  fullValidation?: boolean;
};

export type ImportOutcome =
  | { status: "not-started" }
  | { status: "failed"; message: string }
  | { status: "imported"; imported: number; reloadError?: string };

export type ImportConfig = {
  connectionId: string | null;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  limit: number;
  offset: number;
  engine?: DatabaseEngine;
  firstIsHeaders?: boolean;
  columnMapping?: ImportColumnMapping;
  nullMode?: ImportNullMode;
  fullValidation?: boolean;
  onSuccess: () => Promise<void>;
};

const SQL_DATE = String.raw`\d{4}-\d{1,2}-\d{1,2}`;
const SQL_TIME = String.raw`\d{1,2}:\d{2}(?::\d{2}(?:[.,]\d{1,9})?)?`;
const SQL_ZONE = String.raw`(?:\s*(?:Z|z|UTC|GMT|[+-]\d{1,2}(?::?\d{2})?))?`;
const SQL_DATE_TIME_RE = new RegExp(
  `^(?:${SQL_DATE}(?:[ T]${SQL_TIME}${SQL_ZONE})?|${SQL_TIME}${SQL_ZONE})$`
);

/**
 * Whether text reads as a date, time or timestamp the database can take:
 * the SQL/ISO forms databases print (any fraction of a second, "+07",
 * "+0700" or "+07:00" zones, a space or a "T"), PostgreSQL's infinity,
 * or anything the WebView's own parser accepts. The database still has
 * the last word; this only catches obvious mistakes in the preview.
 */
export function isDateTimeText(value: string): boolean {
  const text = value.trim();
  if (/^[+-]?infinity$/i.test(text)) return true;
  if (SQL_DATE_TIME_RE.test(text)) return true;
  return !Number.isNaN(Date.parse(text));
}

function typeIssue(value: string, dbType?: string): string | null {
  if (value === "") return null;
  const type = dbType?.toLowerCase() ?? "";
  if (/\b(jsonb?|array)\b/.test(type)) {
    try {
      JSON.parse(value);
      return null;
    } catch {
      return "Invalid JSON";
    }
  }
  if (
    /^(tinyint|smallint|mediumint|int|integer|bigint|float|double|real|numeric|decimal)/i.test(
      type
    )
  ) {
    return Number.isFinite(Number(value)) ? null : "Invalid number";
  }
  if (/\b(bool|boolean|bit)\b/.test(type)) {
    return /^(true|false|1|0)$/i.test(value) ? null : "Invalid boolean";
  }
  if (/\b(date|time|timestamp|datetime)\b/.test(type)) {
    return isDateTimeText(value) ? null : "Invalid date/time";
  }
  return null;
}

export function buildDefaultImportMapping(
  preview: DataImportPreview,
  columns: ColumnMeta[],
  firstIsHeaders: boolean
): ImportColumnMapping {
  const mapping: ImportColumnMapping = {};
  const tableCols = columns.map((c) => c.name);
  if (firstIsHeaders) {
    // Exact header first, then the same name ignoring case and spaces.
    const exact = new Map<string, number>();
    const loose = new Map<string, number>();
    preview.headers.forEach((h, i) => {
      const trimmed = h.trim();
      if (!exact.has(trimmed)) exact.set(trimmed, i);
      const key = trimmed.toLowerCase();
      if (!loose.has(key)) loose.set(key, i);
    });
    for (const name of tableCols) {
      const index = exact.get(name) ?? loose.get(name.trim().toLowerCase());
      mapping[name] = index ?? null;
    }
    return mapping;
  }
  tableCols.forEach((name, index) => {
    mapping[name] = index < preview.headers.length ? index : null;
  });
  return mapping;
}

export function validateImportPreview(
  preview: DataImportPreview,
  columns: ColumnMeta[],
  options: ImportOptions
): ImportIssue[] {
  const dataRows = options.firstIsHeaders
    ? preview.rows
    : [preview.headers, ...preview.rows];
  const maxRows = options.fullValidation ? dataRows.length : 100;
  const issues: ImportIssue[] = [];
  for (
    let rowIndex = 0;
    rowIndex < Math.min(dataRows.length, maxRows);
    rowIndex++
  ) {
    const row = dataRows[rowIndex] ?? [];
    for (const column of columns) {
      const csvIndex = options.columnMapping[column.name];
      if (csvIndex == null || csvIndex < 0) continue;
      const raw = row[csvIndex] ?? "";
      if (raw === "" && options.nullMode === "empty-as-null") continue;
      const message = typeIssue(raw, column.db_type);
      if (message) {
        issues.push({
          row: rowIndex + 1,
          column: column.name,
          value: raw,
          message,
        });
      }
    }
  }
  return issues;
}

/**
 * Engines whose structure metadata says which columns are generated
 * (identity, auto-increment, computed). Elsewhere (SQL Server, Oracle, ...)
 * an identity column looks like NOT NULL without a default, so no column
 * is called required there.
 */
const REQUIRED_COLUMN_ENGINES = new Set<DatabaseEngine>([
  "postgres",
  "mysql",
  "mariadb",
  "sqlite",
  "turso",
  "d1",
]);

/**
 * Columns an import must fill: NOT NULL, without a default, not generated
 * (identity, auto-increment, computed). Unknown nullability, an engine
 * without generated-column metadata, or a table structure that has not
 * loaded never marks a column required.
 */
export function requiredImportColumns(
  columns: ColumnMeta[],
  structure: TableStructure[] | null | undefined,
  engine?: DatabaseEngine
): string[] {
  if (!structure?.length) return [];
  if (!engine || !REQUIRED_COLUMN_ENGINES.has(engine)) return [];
  const byName = new Map(structure.map((col) => [col.column_name, col]));
  return columns
    .filter((column) => {
      const info = byName.get(column.name);
      if (!info) return false;
      if (parseNullable(info.is_nullable) !== false) return false;
      if (column.auto_generated || info.is_identity || info.is_generated) {
        return false;
      }
      if (/auto_increment|generated|identity|serial/i.test(info.extra ?? "")) {
        return false;
      }
      const hasDefault =
        info.default_is_null === undefined
          ? !!(info.column_default ?? column.column_default ?? "").trim()
          : !info.default_is_null;
      return !hasDefault;
    })
    .map((column) => column.name);
}

/**
 * Engines whose import runs in one transaction. Usually a failure leaves
 * the table as it was, but that is not certain (MySQL MyISAM tables ignore
 * ROLLBACK; a lost COMMIT reply may follow a successful commit), so the
 * dialog never promises it. D1, Snowflake and ClickHouse run row by row:
 * rows before the failing one may already be saved.
 */
const ATOMIC_IMPORT_ENGINES = new Set<DatabaseEngine>([
  "postgres",
  "mysql",
  "mariadb",
  "sqlite",
  "turso",
  "duckdb",
  "sqlserver",
  "oracle",
]);

export function importUsesTransaction(engine?: DatabaseEngine): boolean {
  return !!engine && ATOMIC_IMPORT_ENGINES.has(engine);
}

function importIssueMessage(issue: ImportIssue): string {
  const preview =
    issue.value.length > 32 ? `${issue.value.slice(0, 32)}...` : issue.value;
  return `row ${issue.row}, column ${issue.column}, value ${JSON.stringify(preview)}: ${issue.message}`;
}

function importExecutionErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/SQL_TX_STATEMENT_(\d+)_FAILED:\s*([\s\S]*)/);
  if (!match) return raw || "Import failed.";
  const reason = match[2]?.trim() || "Database rejected the row.";
  return `Import failed at data row ${match[1]}: ${reason}`;
}

export function useImportTableData() {
  const [dataPreview, setDataPreview] = useState<DataImportPreview | null>(
    null
  );
  const [csvText, setCsvText] = useState<string | null>(null);
  /** The field separator in use: detected on load, or chosen. */
  const [delimiter, setDelimiterState] = useState(",");
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // One import at a time, even for two clicks before a re-render.
  const runningRef = useRef(false);
  const [importProgress, setImportProgress] = useState<{
    imported: number;
    total: number;
  } | null>(null);

  const loadDataImport = useCallback(async (): Promise<boolean> => {
    const path = await openDialog({
      title: "Import table data",
      multiple: false,
      directory: false,
      filters: [{ name: "CSV / TSV", extensions: ["csv", "tsv", "txt"] }],
    });

    if (path == null || typeof path !== "string") {
      return false;
    }

    setError(null);
    try {
      const text = await readTextFile(path);
      const parsed = parseCsv(text, /\.tsv$/i.test(path) ? "\t" : undefined);
      setCsvText(text);
      setDelimiterState(parsed.delimiter);
      setDataPreview({ headers: parsed.headers, rows: parsed.rows });
      return true;
    } catch {
      setDataPreview(null);
      setCsvText(null);
      // The import dialog is not open yet: say so here, not silently.
      void showMessage("The CSV file could not be read or parsed.", {
        title: "Import error",
        kind: "error",
      });
      return false;
    }
  }, []);

  const runImport = useCallback(
    /**
     * How it ended: rows imported (and reloaded, or not), failed, or not
     * started (nothing to do, or already running). Callers that may have
     * gone away meanwhile use it to report the outcome elsewhere.
     */
    async (config: ImportConfig): Promise<ImportOutcome> => {
      const {
        connectionId,
        schema,
        tableName,
        columns,
        engine,
        firstIsHeaders = true,
        columnMapping,
        nullMode = "empty-string",
        fullValidation = false,
        onSuccess,
      } = config;

      if (runningRef.current) return { status: "not-started" };
      if (!dataPreview || csvText == null) return { status: "not-started" };

      const mapping =
        columnMapping ??
        buildDefaultImportMapping(dataPreview, columns, firstIsHeaders);
      const colOrder = columns
        .map((column) => column.name)
        .filter((name) => mapping[name] != null && mapping[name]! >= 0);
      let dataRows: string[][];

      if (firstIsHeaders) {
        if (dataPreview.rows.length === 0) return { status: "not-started" };
        dataRows = dataPreview.rows;
      } else {
        dataRows = [dataPreview.headers, ...dataPreview.rows];
      }

      if (colOrder.length === 0) {
        setError(
          firstIsHeaders
            ? "No CSV columns match table columns."
            : "Table has no columns or CSV has no columns."
        );
        return { status: "not-started" };
      }

      if (!connectionId) {
        setError("Not connected.");
        return { status: "not-started" };
      }

      const issues = validateImportPreview(dataPreview, columns, {
        firstIsHeaders,
        columnMapping: mapping,
        nullMode,
        fullValidation,
      });
      if (issues.length > 0) {
        setError(
          `CSV validation failed: ${issues
            .slice(0, 5)
            .map(importIssueMessage)
            .join("; ")}`
        );
        return { status: "not-started" };
      }

      runningRef.current = true;
      setImporting(true);
      setError(null);
      setImportProgress({ imported: 0, total: dataRows.length });

      let imported: number;
      try {
        const result = await operationImportCsvTransaction({
          connectionId,
          engine,
          schema,
          tableName,
          columns,
          columnMapping: mapping,
          nullMode,
          firstIsHeaders,
          fullValidation,
          csvText,
          delimiter,
        });
        imported = result.imported;
      } catch (err) {
        // Back to the mapping, with the reason; the file and options stay.
        setImportProgress(null);
        const message = importExecutionErrorMessage(err);
        setError(message);
        setImporting(false);
        runningRef.current = false;
        return { status: "failed", message };
      }

      // The rows are in: from here on a failure is not an import failure.
      setImportProgress({ imported, total: dataRows.length });
      setDataPreview(null);
      setCsvText(null);
      try {
        await onSuccess();
        return { status: "imported", imported };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err ?? "");
        const message = `The table could not be reloaded: ${reason}`;
        setError(message);
        return { status: "imported", imported, reloadError: message };
      } finally {
        setImporting(false);
        runningRef.current = false;
      }
    },
    [csvText, dataPreview, delimiter]
  );

  /** Split the loaded file again with another separator. */
  const setDelimiter = useCallback(
    (next: string) => {
      if (csvText == null) return;
      try {
        const parsed = parseCsv(csvText, next);
        setDelimiterState(parsed.delimiter);
        setDataPreview({ headers: parsed.headers, rows: parsed.rows });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err ?? ""));
      }
    },
    [csvText]
  );

  const reset = useCallback(() => {
    setDataPreview(null);
    setCsvText(null);
    setError(null);
    setImportProgress(null);
  }, []);

  return {
    dataPreview,
    delimiter,
    setDelimiter,
    error,
    importing,
    importProgress,
    loadDataImport,
    runImport,
    reset,
    setError,
  };
}
