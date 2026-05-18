import { useCallback, useState } from "preact/hooks";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { parseCsv } from "src/utils/csv";
import { runSqlQuery } from "src/lib/tauri/query";
import type { ColumnMeta } from "src/lib/tauri/types";
import type { DatabaseEngine } from "src/types";
import { formatSqlValue, quoteIdentifier, quoteTableName } from "src/utils/sqlDialect";

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
  onSuccess: () => Promise<void>;
};

const BATCH = 50;

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
  if (/^(tinyint|smallint|mediumint|int|integer|bigint|float|double|real|numeric|decimal)/i.test(type)) {
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
  const issues: ImportIssue[] = [];
  for (let rowIndex = 0; rowIndex < Math.min(dataRows.length, 100); rowIndex++) {
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
      });
      if (issues.length > 0) {
        setError(
          `CSV validation failed: ${issues
            .slice(0, 5)
            .map((issue) => `row ${issue.row} ${issue.column}: ${issue.message}`)
            .join("; ")}`
        );
        return;
      }

      setImporting(true);
      setError(null);
      setImportProgress({ imported: 0, total: dataRows.length });

      const quotedTable = quoteTableName(schema, tableName, engine);
      const quotedCols = colOrder
        .map((c) => quoteIdentifier(c, engine))
        .join(", ");

      try {
        for (let i = 0; i < dataRows.length; i += BATCH) {
          const batch = dataRows.slice(i, i + BATCH);
          const values = batch
            .map((row) => {
              const vals = colOrder.map((col) => {
                const idx = mapping[col]!;
                const raw = row[idx] ?? "";
                const column = columns.find((item) => item.name === col);
                const value = raw === "" && nullMode === "empty-as-null" ? null : raw;
                return formatSqlValue(value, column?.db_type, engine);
              });
              return `(${vals.join(", ")})`;
            })
            .join(", ");
          const sql = `INSERT INTO ${quotedTable} (${quotedCols}) VALUES ${values}`;
          await runSqlQuery(connectionId, sql, { timeoutMs: 30_000 });
          setImportProgress({
            imported: Math.min(i + batch.length, dataRows.length),
            total: dataRows.length,
          });
        }

        setDataPreview(null);
        await onSuccess();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Import failed.");
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
