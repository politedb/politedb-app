import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { saveDialog } from "src/lib/system-dialog";
import {
  buildDefaultMaskedPolicy,
  type MaskingPolicy,
} from "src/lib/exportMasking";
import {
  runStreamingExport,
  type ExportConfig,
  type ExportFormat,
  type ExportOptions,
  type ExportProgress,
} from "src/lib/exportPipeline";
import type { ColumnMeta } from "src/lib/tauri/types";

export type { ExportConfig, ExportFormat, ExportOptions, ExportProgress };

function defaultOptions(): ExportOptions {
  return {
    format: "csv",
    fileName: "",
    columns: [],
    csvOptions: {},
    nullToEmpty: true,
    masked: false,
    maskingPolicy: null,
  };
}

type OwnedExport = {
  runId: number;
  cancel: () => Promise<void>;
};

export function useExportTableData() {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [exportOptions, setExportOptions] =
    useState<ExportOptions>(defaultOptions);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const ownedRef = useRef<OwnedExport | null>(null);
  const runIdRef = useRef(0);

  const cancelOwnedExport = useCallback(async () => {
    const owned = ownedRef.current;
    if (!owned) return;
    await owned.cancel();
    // Do not erase ownership before cleanup completes; clear only if still ours.
    if (ownedRef.current === owned) {
      ownedRef.current = null;
    }
  }, []);

  // Owner teardown: invalidate pending save-dialog identity and cancel in-flight export.
  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      void cancelOwnedExport();
    };
  }, [cancelOwnedExport]);

  const handleChangeFormat = useCallback((next: ExportFormat) => {
    setFormat(next);
    setExportOptions((prev) => ({ ...prev, format: next }));
  }, []);

  const setMaskedMode = useCallback(
    (masked: boolean, selectedColumns: string[]) => {
      setExportOptions((prev) => {
        if (!masked) {
          return {
            ...prev,
            masked: false,
            maskingPolicy: null,
            fileName: prev.fileName.replace(/\.masked$/i, ""),
          };
        }
        const cols =
          selectedColumns.length > 0
            ? selectedColumns
            : prev.columns.length > 0
              ? prev.columns
              : [];
        const maskingPolicy = buildDefaultMaskedPolicy(cols);
        let fileName = prev.fileName || "";
        if (fileName && !/\.masked$/i.test(fileName)) {
          fileName = `${fileName}.masked`;
        }
        const formatSafe: ExportFormat =
          prev.format === "sql" ? "csv" : prev.format;
        setFormat(formatSafe);
        return {
          ...prev,
          masked: true,
          maskingPolicy,
          format: formatSafe,
          fileName,
          columns: cols,
        };
      });
    },
    []
  );

  const setMaskingPolicy = useCallback((maskingPolicy: MaskingPolicy) => {
    setExportOptions((prev) => ({
      ...prev,
      masked: true,
      maskingPolicy,
      columns: [...maskingPolicy.selectedColumns],
    }));
  }, []);

  const setFileName = useCallback((fileName: string, tableName: string) => {
    setExportOptions((prev) => ({
      ...prev,
      fileName: fileName || tableName,
    }));
  }, []);

  const loadExportOptions = useCallback(
    async (columns: ColumnMeta[], tableName: string) => {
      if (columns.length === 0) return;
      // Invalidate pending save-dialog completion and cancel owned export
      // before resetting options (do not drop ownership before cleanup).
      runIdRef.current += 1;
      await cancelOwnedExport();
      const columnNames = columns.map((c) => c.name);
      setExportOptions({
        format: "csv",
        fileName: tableName,
        columns: columnNames,
        csvOptions: {},
        nullToEmpty: true,
        masked: false,
        maskingPolicy: null,
      });
      setProgress(null);
      setFormat("csv");
      setExporting(false);
    },
    [cancelOwnedExport]
  );

  const clearMaskState = useCallback(() => {
    setExportOptions((prev) => ({
      ...prev,
      masked: false,
      maskingPolicy: null,
    }));
  }, []);

  const handleExport = useCallback(
    async (tableName: string, _totalRows: number, config: ExportConfig) => {
      if (exporting || ownedRef.current) {
        setProgress({
          exported: 0,
          error: "Another export is already in progress.",
        });
        return;
      }

      const opts: ExportOptions = {
        ...exportOptions,
        format,
        fileName: exportOptions.fileName || tableName,
        maskingPolicy: exportOptions.masked
          ? (exportOptions.maskingPolicy ??
            buildDefaultMaskedPolicy(
              exportOptions.columns.length
                ? exportOptions.columns
                : config.columns.map((c) => c.name)
            ))
          : null,
      };

      // Ensure ordinary policy shape when not masked (pipeline builds its own).
      if (!opts.masked) {
        opts.maskingPolicy = null;
      }

      const runId = ++runIdRef.current;
      const ext = opts.format;
      const defaultBase = opts.fileName || tableName;
      const path = await saveDialog({
        title: opts.masked ? "Masked export table data" : "Export table data",
        defaultPath: `${defaultBase}.${ext}`,
        filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
      });

      // Late save-dialog response after unmount/context change/supersede:
      // do not start an orphan export.
      if (runId !== runIdRef.current) return;
      if (!path) return;

      setExporting(true);
      setProgress({ exported: 0 });

      const { cancel, done } = runStreamingExport(path, config, opts, {
        onProgress: (p) => {
          if (runId === runIdRef.current) {
            setProgress(p);
          }
        },
      });
      const owned: OwnedExport = { runId, cancel };
      ownedRef.current = owned;

      try {
        const finalProgress = await done;
        if (runId === runIdRef.current) {
          setProgress(finalProgress);
        }
      } catch (err) {
        if (runId === runIdRef.current) {
          setProgress({
            exported: 0,
            error: err instanceof Error ? err.message : "Export failed",
          });
        }
      } finally {
        if (ownedRef.current === owned) {
          ownedRef.current = null;
        }
        if (runId === runIdRef.current) {
          setExporting(false);
        }
      }
    },
    [exportOptions, format, exporting]
  );

  const requestCancel = useCallback(async () => {
    await cancelOwnedExport();
  }, [cancelOwnedExport]);

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
    setMaskedMode,
    setMaskingPolicy,
    clearMaskState,
    requestCancel,
  };
}
