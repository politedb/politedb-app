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
  onSuccess: () => Promise<void>;
};

const BATCH = 50;

export function useImportTableData() {
  const [dataPreview, setDataPreview] = useState<DataImportPreview | null>(
    null
  );
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);

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
      const { connectionId, schema, tableName, columns, onSuccess } = config;

      if (!dataPreview || dataPreview.rows.length === 0) return;

      const tableCols = columns.map((c) => c.name);
      const headerToIndex = new Map(
        dataPreview.headers.map((h, i) => [h.trim(), i])
      );
      const colOrder = tableCols.filter((name) => headerToIndex.has(name));

      if (colOrder.length === 0) {
        setError("No CSV columns match table columns.");
        return;
      }

      if (!connectionId) {
        setError("Not connected.");
        return;
      }

      setImporting(true);
      setError(null);

      const quotedTable = `"${schema.replace(/"/g, '""')}"."${tableName.replace(/"/g, '""')}"`;
      const quotedCols = colOrder
        .map((c) => `"${c.replace(/"/g, '""')}"`)
        .join(", ");
      const escape = (v: string) => `'${String(v).replace(/'/g, "''")}'`;

      try {
        for (let i = 0; i < dataPreview.rows.length; i += BATCH) {
          const batch = dataPreview.rows.slice(i, i + BATCH);
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
  }, []);

  return {
    dataPreview,
    error,
    importing,
    loadDataImport,
    runImport,
    reset,
    setError,
  };
}
