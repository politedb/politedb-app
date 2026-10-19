import { useCallback, useEffect, useMemo } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import { Select } from "src/components/common/Select";
import type { ColumnMeta } from "src/lib/tauri/types";
import { Button } from "src/components/common/Button";
import { type TableFilterCondition, type TableSort } from "src/lib/queries/sql";
import {
  type ExportConfig,
  type ExportFormat,
  useExportTableData,
} from "src/hooks/useExportTableData";
import type { DatabaseEngine, TableConstraint } from "src/types";
import { ExportColumnEditor } from "src/components/modal/export/ExportColumnEditor";
import {
  listKeepColumns,
  listOutputColumns,
  policyHasActiveMasking,
  syncMaskedSelection,
  validateMaskingPolicy,
  withColumnRule,
  type MaskRuleKind,
} from "src/lib/export-masking";
import { cn } from "src/utils/cn";
import { showMessage } from "src/lib/system-dialog";
import { useProGate } from "src/hooks/useProGate";

interface Props {
  open: boolean;
  handleClose: () => void;
  connectionId: string | null;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  constraints?: TableConstraint[] | null;
  appliedFilters: TableFilterCondition[];
  appliedFilterCombine: "AND" | "OR";
  pagination?: { limit: number; offset: number };
  sortState?: TableSort | null;
  /** Best available row estimate, or null when unavailable. */
  totalRows: number | null;
  engine?: DatabaseEngine;
}

export function ExportTableDialog({
  open,
  handleClose,
  connectionId,
  schema,
  tableName,
  columns,
  constraints,
  appliedFilters,
  appliedFilterCombine,
  pagination,
  sortState,
  totalRows,
  engine,
}: Props) {
  const {
    format,
    exporting,
    progress,
    exportOptions,
    setExportOptions,
    setFileName,
    setProgress,
    handleChangeFormat,
    handleExport,
    loadExportOptions,
    clearMaskState,
    requestCancel,
  } = useExportTableData();
  const { requirePro } = useProGate();

  useEffect(() => {
    if (!open) return;
    loadExportOptions(columns, tableName);
  }, [open, columns, tableName, connectionId, loadExportOptions]);

  useEffect(() => {
    if (!open) {
      void requestCancel();
      clearMaskState();
      setProgress(null);
    }
  }, [open, clearMaskState, setProgress, requestCancel]);

  const columnNames = useMemo(
    () => columns.map((c) => c.name).filter(Boolean),
    [columns]
  );

  const totalKnown = typeof totalRows === "number" && totalRows >= 0;
  const cancelled = !!progress?.error && /cancelled/i.test(progress.error);
  const hardError = !!progress?.error && !cancelled;

  const progressPct = useMemo(() => {
    const exported = Math.max(0, progress?.exported ?? 0);

    if (totalKnown) {
      if (totalRows === 0) return exporting ? 0 : 100;
      return Math.min(100, Math.max(0, (exported / totalRows) * 100));
    }

    // There is no honest percentage without a total. Keep the bar at its
    // initial position instead of presenting an invented completion estimate.
    if (exporting) return 0;
    return cancelled || hardError ? 0 : 100;
  }, [cancelled, exporting, hardError, progress, totalKnown, totalRows]);

  // Cancellation is reported only after the pipeline has settled. At this
  // point requestCancel has awaited operation cancellation and temp cleanup,
  // and the hook has observed the final progress state.
  useEffect(() => {
    if (!cancelled || exporting) return;

    // Close the export window before showing the app's native info dialog,
    // matching the completed-export message flow elsewhere in the app.
    setProgress(null);
    clearMaskState();
    void requestCancel();
    handleClose();
    void showMessage("Export is cancelled", {
      title: "Aborted",
      kind: "info",
    });
  }, [
    cancelled,
    exporting,
    setProgress,
    clearMaskState,
    handleClose,
    progress?.error,
    requestCancel,
  ]);

  useEffect(() => {
    if (!hardError || !progress?.error) return;
    void requestCancel();
    handleClose();
    void showMessage(progress.error, {
      title: "Export error",
      kind: "error",
    });
  }, [hardError, progress?.error, requestCancel, handleClose]);

  // Authoritative selection — never fall back empty → all.
  const selectedColumns = exportOptions.columns;

  const maskingPolicy = exportOptions.maskingPolicy;

  const maskValidation = useMemo(() => {
    if (!maskingPolicy) return null;
    return validateMaskingPolicy(maskingPolicy, columnNames);
  }, [maskingPolicy, columnNames]);

  const outputCount = useMemo(() => {
    if (maskingPolicy) {
      if (maskValidation?.ok) return maskValidation.outputColumns.length;
      return listOutputColumns(maskingPolicy).length;
    }
    return selectedColumns.length;
  }, [maskingPolicy, maskValidation, selectedColumns.length]);

  const keepColumns = useMemo(() => {
    if (!maskingPolicy) return [];
    return listKeepColumns(maskingPolicy);
  }, [maskingPolicy]);

  const hasActiveMasking = useMemo(() => {
    if (!maskingPolicy) return false;
    return policyHasActiveMasking(maskingPolicy);
  }, [maskingPolicy]);

  const setSelectedColumns = useCallback(
    (next: string[]) => {
      setExportOptions((prev) => {
        const nextPolicy = syncMaskedSelection(prev.maskingPolicy, next);
        return {
          ...prev,
          masked: true,
          columns: next,
          maskingPolicy: nextPolicy,
        };
      });
    },
    [setExportOptions]
  );

  const handleSelectColumn = useCallback(
    (name: string) => {
      const has = selectedColumns.includes(name);
      const next = has
        ? selectedColumns.filter((c) => c !== name)
        : [...selectedColumns, name];
      setSelectedColumns(next);
    },
    [selectedColumns, setSelectedColumns]
  );

  const handleToggleSelectAll = useCallback(() => {
    if (selectedColumns.length === columnNames.length) {
      setSelectedColumns([]);
      return;
    }
    setSelectedColumns([...columnNames]);
  }, [selectedColumns.length, columnNames, setSelectedColumns]);

  const handleRuleChange = useCallback(
    (name: string, rule: MaskRuleKind) => {
      if (rule !== "keep" && !requirePro("export-masking")) return;
      setExportOptions((prev) => {
        if (!prev.maskingPolicy) return prev;
        return {
          ...prev,
          masked: true,
          maskingPolicy: withColumnRule(prev.maskingPolicy, name, rule),
        };
      });
      const base = exportOptions.maskingPolicy;
      if (
        base &&
        format === "sql" &&
        policyHasActiveMasking(withColumnRule(base, name, rule))
      ) {
        handleChangeFormat("csv");
      }
    },
    [
      setExportOptions,
      exportOptions.maskingPolicy,
      format,
      handleChangeFormat,
      requirePro,
    ]
  );

  const onClose = useCallback(() => {
    if (exporting) return;
    setProgress(null);
    clearMaskState();
    handleClose();
  }, [exporting, handleClose, setProgress, clearMaskState]);

  const onCancelOrClose = useCallback(() => {
    if (exporting) {
      void requestCancel();
      return;
    }
    onClose();
  }, [exporting, requestCancel, onClose]);

  const onExport = useCallback(async () => {
    const exportConfig: ExportConfig = {
      connectionId,
      schema,
      tableName,
      engine,
      appliedFilters,
      appliedFilterCombine,
      pagination,
      sortState,
      constraints,
      columns,
    };
    await handleExport(tableName, totalRows, exportConfig);
  }, [
    tableName,
    connectionId,
    schema,
    totalRows,
    appliedFilters,
    appliedFilterCombine,
    pagination,
    sortState,
    constraints,
    columns,
    engine,
    handleExport,
  ]);

  const suggestedName = exportOptions.fileName || tableName;
  // Completion is based on pipeline settlement (not row-count math).
  const completed = !!progress && !progress.error && !exporting;

  const tableIdentity = schema ? `${schema}.${tableName}` : tableName;
  const scopeLabel = pagination
    ? "Current page"
    : appliedFilters.length > 0
      ? "Filtered rows"
      : "All rows";

  const exportDisabled =
    exporting ||
    columnNames.length === 0 ||
    outputCount === 0 ||
    !maskingPolicy ||
    !maskValidation?.ok;

  const formatLabel = (format || "csv").toUpperCase();

  return (
    <>
      <Dialog
        open={open}
        onClose={onClose}
        size="default"
        closeOnOutsideClick={!exporting}
        className={cn(
          "mx-auto flex w-full flex-col overflow-hidden",
          "max-h-[80vh]"
        )}
      >
        <DialogHeader className="shrink-0 pr-10">
          <DialogTitle className="text-base dark:text-neutral-100">
            Export data
          </DialogTitle>
          <DialogDescription className="truncate dark:text-neutral-400">
            <span title={`${tableIdentity} · ${scopeLabel}`}>
              <span class="font-mono text-neutral-700 dark:text-neutral-200">
                {tableIdentity}
              </span>
              {hasActiveMasking ? (
                <>
                  <span class="text-neutral-400"> · </span>
                  <span>Masked</span>
                </>
              ) : null}
            </span>
          </DialogDescription>
        </DialogHeader>

        <DialogContent className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden py-0">
          {!progress ? (
            <>
              <div class="shrink-0 space-y-3">
                <div class="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div class="min-w-0 flex-1">
                    <label class="mb-1 block text-sm font-medium text-neutral-600">
                      File name
                    </label>
                    <div class="flex min-w-0 items-stretch justify-between overflow-hidden rounded-md border border-neutral-300">
                      <Input
                        value={suggestedName}
                        onValueChange={(value) => setFileName(value, tableName)}
                        placeholder={tableName}
                        className="rounded-none border-0 px-2 py-1.75 font-mono text-sm focus:outline-none"
                        disabled={exporting}
                        aria-label="Export file name"
                      />
                      <span
                        class={cn(
                          "flex shrink-0 items-center border-l border-neutral-300 bg-neutral-50 px-2 font-mono",
                          "text-xs text-neutral-500"
                        )}
                      >
                        .{format}
                      </span>
                    </div>
                  </div>
                  <div class="min-w-0 flex-1 shrink-0">
                    <label class="mb-1 block text-sm font-medium text-neutral-600 dark:text-neutral-300">
                      Format
                    </label>
                    <Select
                      value={format || "csv"}
                      className="h-9 w-full"
                      onChange={(e) =>
                        handleChangeFormat(
                          e.currentTarget.value as ExportFormat
                        )
                      }
                      disabled={exporting}
                      aria-label="Export format"
                    >
                      <option value="csv">CSV</option>
                      <option value="json">JSON</option>
                      <option value="sql" disabled={hasActiveMasking}>
                        SQL
                        {hasActiveMasking ? " (unavailable when masking)" : ""}
                      </option>
                    </Select>
                  </div>
                </div>
              </div>

              <ExportColumnEditor
                columnNames={columnNames}
                selectedColumns={selectedColumns}
                policy={maskingPolicy}
                disabled={exporting}
                selectedCount={selectedColumns.length}
                outputCount={outputCount}
                onToggleColumn={handleSelectColumn}
                onToggleSelectAll={handleToggleSelectAll}
                onRuleChange={handleRuleChange}
              />
            </>
          ) : (
            <div class="rounded-md border border-neutral-200 bg-neutral-50/80 p-3 text-sm dark:bg-neutral-900/60">
              <div class="space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <p class="min-w-0 truncate font-medium text-neutral-800">
                    {suggestedName}.{format}
                    {hasActiveMasking ? " · masked" : ""}
                  </p>
                  <span class="shrink-0 text-xs text-neutral-500 tabular-nums">
                    {totalRows == null
                      ? `${progress.exported.toLocaleString()} rows`
                      : `${progress.exported.toLocaleString()} / ${totalRows.toLocaleString()} rows`}
                  </span>
                </div>
                <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
                  <div
                    class="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
                    style={{ width: `${progressPct}%` }}
                    role="progressbar"
                    aria-valuetext={`${Math.round(progressPct)}% · ${progress.exported.toLocaleString()} rows exported`}
                    aria-label="Export progress"
                    aria-busy={exporting}
                    aria-valuenow={progressPct}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  />
                </div>

                {completed && !progress.error ? (
                  <p class="text-right text-green-600">Completed!</p>
                ) : (
                  <p class="shrink-0 text-right font-medium text-blue-600 tabular-nums">
                    Processing...
                  </p>
                )}
                {progress.warning && (
                  <p class="text-amber-700">{progress.warning}</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>

        <DialogFooter className="shrink-0 flex-wrap items-center justify-between gap-2">
          <div class="h-10 min-w-0 flex-1 text-sm text-neutral-600 dark:text-neutral-300">
            {!progress && (
              <div class="flex h-full flex-wrap items-center gap-x-3">
                <span class="tabular-nums">
                  {outputCount} / {columnNames.length} output column
                  {outputCount === 1 ? "" : "s"}
                </span>
                {keepColumns.length > 0 && (
                  <span
                    class="inline-flex items-center text-amber-700"
                    title={`Keeping original values: ${keepColumns.join(", ")}`}
                  >
                    {keepColumns.length} kept original — may contain sensitive
                    data
                  </span>
                )}
              </div>
            )}
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button
              variant={completed && !progress?.error ? "default" : "outline"}
              onClick={onCancelOrClose}
            >
              {completed && !progress?.error ? "Close" : "Cancel"}
            </Button>
            {!progress && (
              <Button
                variant="default"
                onClick={onExport}
                disabled={exportDisabled}
              >
                {exporting ? "Exporting..." : `Export ${formatLabel}`}
              </Button>
            )}
          </div>
        </DialogFooter>
      </Dialog>
    </>
  );
}
