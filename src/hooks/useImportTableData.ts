import { useCallback, useState } from "preact/hooks";
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
    return Number.isNaN(Date.parse(value)) ? "Invalid date/time" : null;
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
 * Columns an import must fill: NOT NULL, without a default, not generated
 * (identity, auto-increment, computed). Unknown nullability or a table
 * structure that has not loaded never marks a column required.
 */
export function requiredImportColumns(
  columns: ColumnMeta[],
  structure: TableStructure[] | null | undefined
): string[] {
  if (!structure?.length) return [];
  const byName = new Map(structure.map((col) => [col.column_name, col]));
  return columns
    .filter((column) => {
      const info = byName.get(column.name);
      if (!info) return false;
      if (parseNullable(info.is_nullable) !== false) return false;
      if (column.auto_generated || info.is_identity) return false;
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

function importIssueMessage(issue: ImportIssue): string {
  const preview =
    issue.value.length > 32 ? `${issue.value.slice(0, 32)}...` : issue.value;
  return `row ${issue.row}, column ${issue.column}, value ${JSON.stringify(preview)}: ${issue.message}`;
}

function importExecutionErrorMessage(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/SQL_TX_STATEMENT_(\d+)_FAILED:\s*(.*)/);
  if (!match) return raw || "Import failed.";
  const reason = match[2]?.trim() || "Database rejected the row.";
  return `Import failed at data row ${match[1]}: ${reason}`;
}

export function useImportTableData() {
  const [dataPreview, setDataPreview] = useState<DataImportPreview | null>(
    null
  );
  const [csvText, setCsvText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    imported: number;
    total: number;
  } | null>(null);

  const loadDataImport = useCallback(async (): Promise<boolean> => {
    const path = await openDialog({
      title: "Import table data",
      multiple: false,
      directory: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });

    if (path == null || typeof path !== "string") {
      return false;
    }

    setError(null);
    try {
      const text = await readTextFile(path);
      const { headers, rows } = parseCsv(text);
      setCsvText(text);
      setDataPreview({ headers, rows });
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
    async (config: ImportConfig) => {
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

      if (!dataPreview || csvText == null) return;

      const mapping =
        columnMapping ??
        buildDefaultImportMapping(dataPreview, columns, firstIsHeaders);
      const colOrder = columns
        .map((column) => column.name)
        .filter((name) => mapping[name] != null && mapping[name]! >= 0);
      let dataRows: string[][];

      if (firstIsHeaders) {
        if (dataPreview.rows.length === 0) return;
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
        return;
      }

      if (!connectionId) {
        setError("Not connected.");
        return;
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
        return;
      }

      setImporting(true);
      setError(null);
      setImportProgress({ imported: 0, total: dataRows.length });

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
        });
        setImportProgress({
          imported: result.imported,
          total: dataRows.length,
        });

        setDataPreview(null);
        setCsvText(null);
        await onSuccess();
      } catch (err) {
        // Back to the mapping, with the reason; the file and options stay.
        setImportProgress(null);
        setError(importExecutionErrorMessage(err));
      } finally {
        setImporting(false);
      }
    },
    [csvText, dataPreview]
  );

  const reset = useCallback(() => {
    setDataPreview(null);
    setCsvText(null);
    setError(null);
    setImportProgress(null);
  }, []);

  return {
    dataPreview,
    error,
    importing,
    importProgress,
    loadDataImport,
    runImport,
    reset,
    setError,
  };
}
