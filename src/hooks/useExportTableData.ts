import { useCallback, useState } from "preact/hooks";
import { type CsvExportOptions, serializeCsvChunk } from "src/utils/csv";
import { type ColumnMeta } from "src/lib/tauri/types";
import { tableExportQuery, type TableFilterCondition } from "./queries";
import { formatJsonChunk, formatSqlChunk } from "src/utils/exportFormats";
import { invoke } from "@tauri-apps/api/core";
import { CMD } from "src/lib/tauri/commands";
import { startSqlQueryStream } from "src/lib/tauri/query";
import { operationBus } from "src/lib/tauri/operationBus";
import { save } from "@tauri-apps/plugin-dialog";

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
    async (
      path: string,
      totalRows: number,
      config: ExportConfig,
      opts: ExportOptions
    ) => {
      const {
        connectionId: connId,
        schema,
        tableName,
        engine,
        appliedFilters,
        appliedFilterCombine,
        columns,
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
      const q = tableExportQuery(
        schema,
        tableName,
        columnNames,
        appliedFilters.length ? appliedFilters : undefined,
        appliedFilterCombine,
        engine
      );
      const opId = await startSqlQueryStream(connId, q, {
        batchSize: 50,
        maxRows: 10_000_000,
      });
      let totalExported = 0;
      let isFirstChunk = true;
      setProgress({ exported: 0 });

      await operationBus.subscribe(opId, {
        onChunk: async (chunk) => {
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
            await invoke(CMD.exportAppendToFile, {
              path,
              content,
              append: false,
            });
          } catch (e) {
            setProgress((p) => ({
              ...p!,
              error: e instanceof Error ? e.message : "Write failed",
            }));
            return;
          }

          totalExported += rows.length;
          setProgress({ exported: totalExported });
          isFirstChunk = false;
        },
        onDone: async () => {
          let content = "";
          if (totalRows > 0 && format === "json") {
            content = "]";
          } else if (format === "csv" && totalRows === 0) {
            content = serializeCsvChunk(columnNames, [], opts.csvOptions, true);
          }

          try {
            await invoke(CMD.exportAppendToFile, {
              path,
              content,
              append: totalRows > 0,
            });
          } catch {}

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
    async (tableName: string, totalRows: number, config: ExportConfig) => {
      const opts = {
        ...exportOptions,
        format,
        fileName: exportOptions.fileName || tableName,
      };

      const ext = opts.format;
      const path = await save({
        title: "Export table data",
        defaultPath: `${opts.fileName || tableName}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });
      if (!path) return;
      setExporting(true);
      setProgress({ exported: 0 });

      try {
        await runStreamingExport(path, totalRows, config, opts);
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
