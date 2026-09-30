import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
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
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { MaskedColumnRules } from "src/components/modal/export/MaskedColumnRules";
import {
  syncMaskedSelection,
  validateMaskingPolicy,
} from "src/lib/exportMasking";

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
    setMaskingPolicy,
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

  const [columnSearch, setColumnSearch] = useState("");
  const filteredColumnNames = useMemo(() => {
    const q = columnSearch.trim().toLowerCase();
    if (!q) return columnNames;
    return columnNames.filter((name) => name.toLowerCase().includes(q));
  }, [columnNames, columnSearch]);

  const selectedColumns = useMemo(
    () =>
      exportOptions.columns.length > 0 ? exportOptions.columns : columnNames,
    [exportOptions.columns, columnNames]
  );

  const masked = exportOptions.masked === true;

  const maskPolicyOk = useMemo(() => {
    if (!masked || !exportOptions.maskingPolicy) return !masked;
    return validateMaskingPolicy(exportOptions.maskingPolicy, columnNames).ok;
  }, [masked, exportOptions.maskingPolicy, columnNames]);

  const setSelectedColumns = useCallback(
    (next: string[]) => {
      const resolved =
        next.length === 0 || next.length === columnNames.length ? [] : next;
      setExportOptions((prev) => {
        if (!prev.masked) {
          return { ...prev, columns: resolved };
        }
        const maskingPolicy = syncMaskedSelection(
          prev.maskingPolicy,
          // Masked mode: no silent fallback to all when empty
          next
        );
        return {
          ...prev,
          columns: next,
          maskingPolicy,
        };
      });
    },
    [columnNames, setExportOptions]
  );

  const handleSelectColumn = useCallback(
    (name: string) => {
      const has = selectedColumns.includes(name);
      const next = has
        ? selectedColumns.filter((c) => c !== name)
        : [...selectedColumns, name];
      if (masked) {
        setSelectedColumns(next);
        return;
      }
      const atLeastOne = next.length > 0 ? next : columnNames;
      setSelectedColumns(atLeastOne);
    },
    [columnNames, selectedColumns, setSelectedColumns, masked]
  );

  const selectAllColumns = useCallback(() => {
    if (masked) {
      setSelectedColumns([...columnNames]);
      return;
    }
    setSelectedColumns([]);
  }, [setSelectedColumns, masked, columnNames]);

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

  return (
    <>
      <Dialog open={open} onClose={onClose} size={masked ? "md" : "sm"}>
        <DialogHeader>
          <DialogTitle className="text-base">
            {masked
              ? pagination
                ? "Masked export — current page"
                : `Masked export — '${tableName}'`
              : pagination
                ? "Export current page"
                : `Export table '${tableName}'`}
          </DialogTitle>
        </DialogHeader>
        <DialogContent className="py-0">
          <div class="space-y-4">
            {!progress ? (
              <>
                <div>
                  <label class="mb-1 block text-sm font-medium text-neutral-600 dark:text-neutral-300">
                    File name
                  </label>
                  <Input
                    value={suggestedName}
                    onValueChange={(value) => setFileName(value, tableName)}
                    placeholder={tableName}
                    className="rounded-md border border-neutral-300 px-2 py-[6.25px] font-mono text-sm dark:border-neutral-600"
                    disabled={exporting}
                  />
                  <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    Export as .{format}
                    {masked ? " (suggested .masked suffix)" : ""}
                  </p>
                </div>
                <div>
                  <div class="mb-1 flex items-center justify-between">
                    <label class="block text-sm font-medium text-neutral-600 dark:text-neutral-300">
                      Select fields to export
                    </label>
                    <Button
                      variant="ghost"
                      onClick={selectAllColumns}
                      class="px-0 text-xs text-blue-600 hover:bg-transparent hover:underline dark:text-blue-400"
                      disabled={exporting}
                    >
                      Select all ({columnNames.length})
                    </Button>
                  </div>
                  <Input
                    type="text"
                    value={columnSearch}
                    onValueChange={setColumnSearch}
                    disabled={exporting}
                    placeholder="Search columns..."
                    className="mb-1 rounded-md border border-neutral-300 px-2 py-1 text-sm dark:border-neutral-600"
                  />
                  <OverlayScrollArea
                    className="max-h-40 rounded-md border border-neutral-300 bg-white dark:border-neutral-600 dark:bg-neutral-900"
                    contentClassName="space-y-1 p-2"
                  >
                    {filteredColumnNames.length > 0 ? (
                      filteredColumnNames.map((name) => (
                        <Checkbox
                          key={name}
                          checked={selectedColumns.includes(name)}
                          onChange={() => handleSelectColumn(name)}
                          label={name}
                          disabled={exporting}
                        />
                      ))
                    ) : (
                      <div class="flex items-center justify-center p-2 text-sm text-neutral-500 dark:text-neutral-400">
                        No columns found. Try a different search.
                      </div>
                    )}
                  </OverlayScrollArea>
                  <p class="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
                    {selectedColumns.length === 0
                      ? masked
                        ? "No columns selected — masked export will be blocked"
                        : "No columns selected"
                      : selectedColumns.length === columnNames.length
                        ? "All fields selected"
                        : `${selectedColumns.length} of ${columnNames.length} columns selected`}
                  </p>
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
                    label="Masked Export"
                    description="Per-column redact / null / omit. Does not modify the database. Not anonymization or compliance."
                  />
                </div>

                {masked && exportOptions.maskingPolicy && (
                  <MaskedColumnRules
                    policy={exportOptions.maskingPolicy}
                    disabled={exporting}
                    onChange={setMaskingPolicy}
                  />
                )}

                <div>
                  <label class="mb-1 block text-sm font-medium text-neutral-600 dark:text-neutral-300">
                    Select format
                  </label>
                  <Select
                    value={format || "csv"}
                    className="w-full"
                    onChange={(e) =>
                      handleChangeFormat(e.currentTarget.value as ExportFormat)
                    }
                    disabled={exporting}
                  >
                    <option value="csv">csv</option>
                    <option value="json">json</option>
                    <option value="sql" disabled={masked}>
                      sql{masked ? " (disabled in Masked Export)" : ""}
                    </option>
                  </Select>
                </div>
              </>
            ) : (
              <div class="rounded-md border border-neutral-200 bg-neutral-50/80 p-3 text-xs dark:border-neutral-700 dark:bg-neutral-900/60">
                <div class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <p class="min-w-0 truncate font-medium text-neutral-800 dark:text-neutral-100">
                      {suggestedName}.{format}
                      {masked ? " · masked" : ""}
                    </p>
                    <span class="shrink-0 text-neutral-500 tabular-nums dark:text-neutral-400">
                      {progress.exported} / {totalRows} rows
                    </span>
                  </div>
                  <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-700">
                    <div
                      class="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
                      style={{ width: `${Math.min(100, progressPct)}%` }}
                    />
                  </div>
                  {completed && !progress.error && (
                    <p class="text-right text-green-600 dark:text-green-400">
                      Completed!
                    </p>
                  )}
                  {progress.warning && (
                    <p class="text-amber-700 dark:text-amber-300">
                      {progress.warning}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
        <DialogFooter>
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
              disabled={
                exporting ||
                columnNames.length === 0 ||
                (masked && (selectedColumns.length === 0 || !maskPolicyOk))
              }
            >
              {exporting ? "Exporting..." : masked ? "Masked Export" : "Export"}
            </Button>
          )}
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
