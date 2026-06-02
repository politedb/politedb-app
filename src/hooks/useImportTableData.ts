import { useCallback, useState } from "preact/hooks";
import { openDialog } from "src/lib/system-dialog";
import { readTextFile } from "src/lib/system-fs";
import { parseCsv } from "src/utils/csv";
import { operationImportCsvTransaction } from "src/lib/tauri";
import type { ColumnMeta } from "src/lib/tauri/types";
import type { DatabaseEngine } from "src/types";

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
    const headerToIndex = new Map(preview.headers.map((h, i) => [h.trim(), i]));
    for (const name of tableCols) {
      mapping[name] = headerToIndex.has(name) ? headerToIndex.get(name)! : null;
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
  return `Import failed at row ${match[1]}, column unknown, value unavailable: ${reason}`;
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
      setError("Failed to read or parse CSV file.");
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
