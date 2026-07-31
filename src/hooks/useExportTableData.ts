import { useCallback, useState } from "preact/hooks";
import { type CsvExportOptions, serializeCsvChunk } from "src/utils/csv";
import { type ColumnMeta } from "src/lib/tauri/types";
import {
  tableExportQuery,
  type TableFilterCondition,
  type TableSort,
} from "src/lib/queries/sql";
import { formatJsonChunk, formatSqlChunk } from "src/utils/exportFormats";
import { exportAppendToFile } from "src/lib/tauri/export";
import { startSqlQueryStream } from "src/lib/tauri/query";
import { operationCancel } from "src/lib/tauri";
import { operationBus } from "src/lib/tauri/operationBus";
import { saveDialog } from "src/lib/system-dialog";
import type { TableConstraint } from "src/types";
import { resolveDefaultTableSort } from "src/utils/tableSort";

export type ExportFormat = "csv" | "json" | "sql";

export type ExportProgress = {
  exported: number;
  error?: string;
};

export type ExportOptions = {
  format: ExportFormat;
  fileName: string;
  columns: string[];
  csvOptions: CsvExportOptions;
  nullToEmpty: boolean;
};

export type ExportConfig = {
  columns: ColumnMeta[];
  connectionId: string | null;
  schema: string;
  tableName: string;
  engine?: import("src/types").DatabaseEngine;
  appliedFilters: TableFilterCondition[];
  appliedFilterCombine: "AND" | "OR";
  pagination?: { limit: number; offset: number };
  sortState?: TableSort | null;
  constraints?: TableConstraint[] | null;
};

export function useExportTableData() {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [exportOptions, setExportOptions] = useState<ExportOptions>(() => ({
    format: "csv",
    fileName: "",
    columns: [],
    csvOptions: {},
    nullToEmpty: false,
  }));
  const [format, setFormat] = useState<ExportFormat>(exportOptions.format);

  const handleChangeFormat = useCallback(
    (format: ExportFormat) => {
      setFormat(format);
      setExportOptions((prev) => ({ ...prev, format }));
    },
    [setExportOptions]
  );

  const setFileName = useCallback(
    (fileName: string, tableName: string) => {
      setExportOptions((prev) => ({
        ...prev,
        fileName: fileName || tableName,
      }));
    },
    [setExportOptions]
  );

  const loadExportOptions = useCallback(
    async (columns: ColumnMeta[], tableName: string) => {
      if (columns.length === 0) return;
      const columnNames = columns.map((c) => c.name);
      setExportOptions((prev) => ({
        ...prev,
        format: "csv",
        fileName: tableName,
        columns: columnNames,
        csvOptions: prev.csvOptions || {},
        nullToEmpty: true,
      }));
      setProgress(null);
      setFormat("csv");
    },
    [setExportOptions, setProgress]
  );

  const runStreamingExport = useCallback(
    async (path: string, config: ExportConfig, opts: ExportOptions) => {
      const {
        connectionId: connId,
        schema,
        tableName,
        engine,
        appliedFilters,
        appliedFilterCombine,
        columns,
        pagination,
        sortState,
        constraints,
      } = config;

      if (!connId) {
        setProgress({ exported: 0, error: "Not connected." });
        return;
      }
      const columnNames = opts.columns.length
        ? opts.columns
        : (columns ?? []).map((c) => c.name);

      if (columnNames.length === 0) {
        setProgress({ exported: 0, error: "No columns to export." });
        return;
      }
      const format = opts.format as ExportFormat;
      const querySort =
        sortState ??
        resolveDefaultTableSort({
          columns,
          constraints,
          engine,
        });
      const q = tableExportQuery(
        schema,
        tableName,
        columnNames,
        appliedFilters.length ? appliedFilters : undefined,
        appliedFilterCombine,
        engine,
        pagination,
        querySort
      );
      const opId = await startSqlQueryStream(connId, q, {
        batchSize: 50,
        maxRows: pagination ? pagination.limit : 10_000_000,
      });
      let totalExported = 0;
      let isFirstChunk = true;
      let fatalWriteError: string | null = null;
      let unsub: (() => void) | null = null;
      setProgress({ exported: 0 });

      unsub = await operationBus.subscribe(opId, {
        onChunk: async (chunk) => {
          if (fatalWriteError) return;
          const rows = chunk.rows ?? [];
          if (rows.length === 0) return;
          const cols = chunk.columns?.map((c) => c.name) ?? columnNames;
          let content = "";
          if (format === "csv") {
            content = serializeCsvChunk(
              cols,
              rows,
              opts.csvOptions,
              isFirstChunk
            );
          } else if (format === "json") {
            const chunkPart = formatJsonChunk(
              cols,
              rows,
              isFirstChunk,
              opts.nullToEmpty !== false
            );
            content = (isFirstChunk ? "[" : "") + chunkPart;
          } else {
            content = formatSqlChunk(schema, tableName, cols, rows, engine);
          }

          try {
            await exportAppendToFile({
              path,
              content,
              append: !isFirstChunk,
            });
          } catch (e) {
            fatalWriteError = e instanceof Error ? e.message : "Write failed";
            setExporting(false);
            setProgress({ exported: totalExported, error: fatalWriteError });
            try {
              unsub?.();
            } catch {}
            try {
              await operationCancel(opId);
            } catch {}
            return;
          }

          totalExported += rows.length;
          setProgress({ exported: totalExported });
          isFirstChunk = false;
        },
        onDone: async () => {
          if (fatalWriteError) {
            setExporting(false);
            setProgress({ exported: totalExported, error: fatalWriteError });
            return;
          }
          let content = "";
          if (totalExported > 0 && format === "json") {
            content = "]";
          } else if (format === "json") {
            content = "[]";
          } else if (format === "csv" && totalExported === 0) {
            content = serializeCsvChunk(columnNames, [], opts.csvOptions, true);
          }

          try {
            await exportAppendToFile({
              path,
              content,
              append: totalExported > 0,
            });
          } catch (e) {
            setExporting(false);
            setProgress({
              exported: totalExported,
              error: e instanceof Error ? e.message : "Write failed",
            });
            return;
          }

          setExporting(false);
          setProgress((p) =>
            p ? { ...p, exported: totalExported } : { exported: totalExported }
          );
        },
        onError: (err) => {
          setExporting(false);
          setProgress({
            exported: totalExported,
            error:
              typeof err === "string" ? err : (err?.message ?? "Export failed"),
          });
        },
      }); // subscription stays active until onDone/onError
    },
    []
  );

  const handleExport = useCallback(
    async (tableName: string, _totalRows: number, config: ExportConfig) => {
      const opts = {
        ...exportOptions,
        format,
        fileName: exportOptions.fileName || tableName,
      };

      const ext = opts.format;
      const path = await saveDialog({
        title: "Export table data",
        defaultPath: `${opts.fileName || tableName}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!path) return;
      setExporting(true);
      setProgress({ exported: 0 });

      try {
        await runStreamingExport(path, config, opts);
      } catch (err) {
        setProgress({
          exported: 0,
          error: err instanceof Error ? err.message : "Export failed",
        });
        setExporting(false);
      }
    },
    [exportOptions, format, runStreamingExport]
  );

  return {
    exporting,
    progress,
    exportOptions,
    format,
    setProgress,
    setExporting,
    setExportOptions,
    setFileName,
    handleChangeFormat,
    handleExport,
    loadExportOptions,
  };
}
