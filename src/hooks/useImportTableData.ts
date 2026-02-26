import { useCallback, useState } from "preact/hooks";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { parseCsv } from "src/utils/csv";
import { runSqlQuery } from "src/lib/tauri/query";
import type { ColumnMeta } from "src/lib/tauri/types";

export type DataImportPreview = {
  headers: string[];
  rows: string[][];
};

export type ImportConfig = {
  connectionId: string | null;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  limit: number;
  offset: number;
  firstIsHeaders?: boolean;
  onSuccess: () => Promise<void>;
};

const BATCH = 50;

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
        firstIsHeaders = true,
        onSuccess,
      } = config;

      if (!dataPreview) return;

      const tableCols = columns.map((c) => c.name);
      let colOrder: string[];
      let headerToIndex: Map<string, number>;
      let dataRows: string[][];

      if (firstIsHeaders) {
        if (dataPreview.rows.length === 0) return;
        headerToIndex = new Map(
          dataPreview.headers.map((h, i) => [h.trim(), i])
        );
        colOrder = tableCols.filter((name) => headerToIndex.has(name));
        dataRows = dataPreview.rows;
      } else {
        colOrder = tableCols.slice(0, dataPreview.headers.length);
        headerToIndex = new Map(colOrder.map((name, i) => [name, i]));
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

      setImporting(true);
      setError(null);
      setImportProgress({ imported: 0, total: dataRows.length });

      const quotedTable = `"${schema.replace(/"/g, '""')}"."${tableName.replace(/"/g, '""')}"`;
      const quotedCols = colOrder
        .map((c) => `"${c.replace(/"/g, '""')}"`)
        .join(", ");
      const escape = (v: string) => `'${String(v).replace(/'/g, "''")}'`;

      try {
        for (let i = 0; i < dataRows.length; i += BATCH) {
          const batch = dataRows.slice(i, i + BATCH);
          const values = batch
            .map((row) => {
              const vals = colOrder.map((col) => {
                const idx = headerToIndex.get(col)!;
                const raw = row[idx] ?? "";
                return escape(raw);
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
