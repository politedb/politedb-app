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
import { ErrorDialog } from "./ErrorDialog";
import { Checkbox } from "src/components/common/Checkbox";
import type { DatabaseEngine, TableConstraint } from "src/types";
import { ExportColumnEditor } from "src/components/modal/export/ExportColumnEditor";
import {
  listKeepColumns,
  listOutputColumns,
  syncMaskedSelection,
  validateMaskingPolicy,
  withColumnRule,
  type MaskRuleKind,
} from "src/lib/exportMasking";
import { cn } from "src/utils/cn";

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
  totalRows: number;
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
    setMaskedMode,
    clearMaskState,
    requestCancel,
  } = useExportTableData();

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

  const progressPct = useMemo(() => {
    if (!totalRows) return 0;
    return ((progress?.exported ?? 0) / totalRows) * 100;
  }, [progress, totalRows]);

  const masked = exportOptions.masked === true;

  // Authoritative selection — never fall back empty → all in masked mode.
  const selectedColumns = useMemo(() => {
    if (masked) return exportOptions.columns;
    // Ordinary: empty stored list still means "all" for pipeline compatibility,
    // but after loadExportOptions we keep an explicit list for accurate UX counts.
    return exportOptions.columns;
  }, [exportOptions.columns, masked]);

  const maskValidation = useMemo(() => {
    if (!masked || !exportOptions.maskingPolicy) {
      return null;
    }
    return validateMaskingPolicy(exportOptions.maskingPolicy, columnNames);
  }, [masked, exportOptions.maskingPolicy, columnNames]);

  const outputCount = useMemo(() => {
    if (masked && exportOptions.maskingPolicy) {
      if (maskValidation?.ok) return maskValidation.outputColumns.length;
      return listOutputColumns(exportOptions.maskingPolicy).length;
    }
    return selectedColumns.length;
  }, [
    masked,
    exportOptions.maskingPolicy,
    maskValidation,
    selectedColumns.length,
  ]);

  const keepColumns = useMemo(() => {
    if (!masked || !exportOptions.maskingPolicy) return [];
    return listKeepColumns(exportOptions.maskingPolicy);
  }, [masked, exportOptions.maskingPolicy]);

  const setSelectedColumns = useCallback(
    (next: string[]) => {
      setExportOptions((prev) => {
        if (!prev.masked) {
          return { ...prev, columns: next };
        }
        const maskingPolicy = syncMaskedSelection(prev.maskingPolicy, next);
        return {
          ...prev,
          columns: next,
          maskingPolicy,
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
      setExportOptions((prev) => {
        if (!prev.maskingPolicy) return prev;
        const maskingPolicy = withColumnRule(prev.maskingPolicy, name, rule);
        return { ...prev, maskingPolicy };
      });
    },
    [setExportOptions]
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

  const onToggleMasked = useCallback(
    (checked: boolean) => {
      setMaskedMode(checked, selectedColumns);
    },
    [setMaskedMode, selectedColumns]
  );

  const suggestedName = exportOptions.fileName || tableName;
  const completed =
    !!progress &&
    !progress.error &&
    !exporting &&
    (totalRows === 0 ||
      progress.exported >= totalRows ||
      !!progress.truncated ||
      !!progress.warning);

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
    (masked && (!exportOptions.maskingPolicy || !maskValidation?.ok));

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
              {masked ? (
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
                      <option value="sql" disabled={masked}>
                        SQL{masked ? " (unavailable when masked)" : ""}
                      </option>
                    </Select>
                  </div>
                </div>

                <div class="rounded-md border border-neutral-200 px-2 py-1.5 dark:border-neutral-700">
                  <Checkbox
                    checked={masked}
                    onChange={(e) =>
                      onToggleMasked(
                        (e.currentTarget as HTMLInputElement).checked
                      )
                    }
                    disabled={exporting}
                    label="Mask sensitive values"
                    description="Per-column redact / null / keep. Uncheck a column to exclude it. Does not modify the database."
                  />
                </div>
              </div>

              <ExportColumnEditor
                columnNames={columnNames}
                selectedColumns={selectedColumns}
                masked={masked}
                policy={exportOptions.maskingPolicy}
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
                    {masked ? " · masked" : ""}
                  </p>
                  <span class="shrink-0 text-xs text-neutral-500 tabular-nums">
                    {progress.exported} / {totalRows} rows
                  </span>
                </div>
                <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
                  <div
                    class="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
                    style={{ width: `${Math.min(100, progressPct)}%` }}
                  />
                </div>
                {completed && !progress.error && (
                  <p class="text-right text-green-600">Completed!</p>
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
              <div class="flex h-full flex-wrap items-center gap-x-3 gap-y-0.5">
                <span class="tabular-nums">
                  {outputCount} output column{outputCount === 1 ? "" : "s"}
                </span>
                {masked && keepColumns.length > 0 && (
                  <span
                    class="inline-flex items-center gap-1.5 text-amber-800"
                    title={`Keeping original values: ${keepColumns.join(", ")}`}
                  >
                    <span
                      class="inline-block size-1.5 rounded-full bg-amber-500"
                      aria-hidden="true"
                    />
                    {keepColumns.length} kept original
                    <span class="text-amber-700/80 dark:text-amber-300/80">
                      — may contain sensitive data
                    </span>
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

      {progress?.error && (
        <ErrorDialog
          open={true}
          error={progress.error}
          onClose={handleClose}
          size="md"
        />
      )}
    </>
  );
}
