import { useCallback, useState } from "preact/hooks";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { parseCsv } from "src/utils/csv";
import { operationExecuteTransaction } from "src/lib/tauri";
import type { ColumnMeta } from "src/lib/tauri/types";
import type { DatabaseEngine } from "src/types";
import {
  formatSqlValue,
  quoteIdentifier,
  quoteTableName,
} from "src/utils/sqlDialect";

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

export type ImportStatementPlan = {
  statements: string[];
  rowNumbers: number[];
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

export function buildImportInsertPlan(args: {
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  rows: string[][];
  columnMapping: ImportColumnMapping;
  nullMode: ImportNullMode;
  engine?: DatabaseEngine;
}): ImportStatementPlan {
  const { schema, tableName, columns, rows, columnMapping, nullMode, engine } =
    args;
  const colOrder = columns
    .map((column) => column.name)
    .filter((name) => columnMapping[name] != null && columnMapping[name]! >= 0);

  const quotedTable = quoteTableName(schema, tableName, engine);
  const quotedCols = colOrder.map((c) => quoteIdentifier(c, engine)).join(", ");
  const statements: string[] = [];
  const rowNumbers: number[] = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] ?? [];
    const vals = colOrder.map((col) => {
      const idx = columnMapping[col]!;
      const raw = row[idx] ?? "";
      const column = columns.find((item) => item.name === col);
      const value = raw === "" && nullMode === "empty-as-null" ? null : raw;
      return formatSqlValue(value, column?.db_type, engine);
    });
    statements.push(
      `INSERT INTO ${quotedTable} (${quotedCols}) VALUES (${vals.join(", ")})`
    );
    rowNumbers.push(rowIndex + 1);
  }

  return { statements, rowNumbers };
}

function importIssueMessage(issue: ImportIssue): string {
  const preview =
    issue.value.length > 32 ? `${issue.value.slice(0, 32)}...` : issue.value;
  return `row ${issue.row}, column ${issue.column}, value ${JSON.stringify(preview)}: ${issue.message}`;
}

function importExecutionErrorMessage(error: unknown, rowNumbers: number[]) {
  const raw = error instanceof Error ? error.message : String(error);
  const match = raw.match(/SQL_TX_STATEMENT_(\d+)_FAILED:\s*(.*)/);
  if (!match) return raw || "Import failed.";

  const statementIndex = Number(match[1]);
  const reason = match[2]?.trim() || "Database rejected the row.";
  const rowNumber = rowNumbers[statementIndex - 1] ?? statementIndex;
  return `Import failed at row ${rowNumber}, column unknown, value unavailable: ${reason}`;
}

export function useImportTableData() {
  const [dataPreview, setDataPreview] = useState<DataImportPreview | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    imported: number;
    total: number;
  } | null>(null);

  const loadDataImport = useCallback(async (): Promise<boolean> => {
    const path = await open({
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
      setDataPreview({ headers, rows });
      return true;
    } catch {
      setDataPreview(null);
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

      if (!dataPreview) return;

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

      const importPlan = buildImportInsertPlan({
        schema,
        tableName,
        columns,
        rows: dataRows,
        columnMapping: mapping,
        nullMode,
        engine,
      });

      try {
        await operationExecuteTransaction({
          connectionId,
          statements: importPlan.statements,
        });
        setImportProgress({
          imported: dataRows.length,
          total: dataRows.length,
        });

        setDataPreview(null);
        await onSuccess();
      } catch (err) {
        setError(importExecutionErrorMessage(err, importPlan.rowNumbers));
      } finally {
        setImporting(false);
      }
    },
    [dataPreview]
  );

  const reset = useCallback(() => {
    setDataPreview(null);
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
