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
import { type TableFilterCondition } from "src/hooks/queries";
import {
  type ExportConfig,
  type ExportFormat,
  useExportTableData,
} from "src/hooks/useExportTableData";
import { cn } from "src/utils/cn";
import { sleep } from "src/utils/common";
import { ErrorDialog } from "./ErrorDialog";

interface Props {
  open: boolean;
  handleClose: () => void;
  connectionId: string | null;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  appliedFilters: TableFilterCondition[];
  appliedFilterCombine: "AND" | "OR";
  totalRows: number;
}

export function ExportTableDialog({
  open,
  handleClose,
  connectionId,
  schema,
  tableName,
  columns,
  appliedFilters,
  appliedFilterCombine,
  totalRows,
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
  } = useExportTableData();

  useEffect(() => {
    if (!open) return;
    loadExportOptions(columns, tableName);
  }, [open, columns, tableName, loadExportOptions]);

  const columnNames = useMemo(
    () => columns.map((c) => c.name).filter(Boolean),
    [columns]
  );

  const progressPct = useMemo(() => {
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

  const setSelectedColumns = useCallback(
    (next: string[]) => {
      const resolved =
        next.length === 0 || next.length === columnNames.length ? [] : next;
      setExportOptions((prev) => ({ ...prev, columns: resolved }));
    },
    [columnNames, setExportOptions]
  );

  const handleSelectColumn = useCallback(
    (name: string) => {
      const has = selectedColumns.includes(name);
      const next = has
        ? selectedColumns.filter((c) => c !== name)
        : [...selectedColumns, name];
      const atLeastOne = next.length > 0 ? next : columnNames;
      setSelectedColumns(atLeastOne);
    },
    [columnNames, selectedColumns, setSelectedColumns]
  );

  const selectAllColumns = useCallback(() => {
    setSelectedColumns([]);
  }, [setSelectedColumns]);

  const onClose = useCallback(() => {
    if (exporting) return;
    setProgress(null);
    handleClose();
  }, [exporting, handleClose, setProgress]);

  const onExport = useCallback(async () => {
    const exportConfig: ExportConfig = {
      connectionId,
      schema,
      tableName,
      appliedFilters,
      appliedFilterCombine,
      columns,
    };
    await handleExport(tableName, totalRows, exportConfig);
    await sleep(500);
    await onClose();
  }, [
    tableName,
    connectionId,
    schema,
    tableName,
    totalRows,
    appliedFilters,
    appliedFilterCombine,
    columns,
    handleExport,
  ]);

  return (
    <>
      <Dialog open={open} onClose={onClose} size="sm">
        <DialogHeader>
          <DialogTitle className="text-base">
            Export table '{tableName}'
          </DialogTitle>
        </DialogHeader>
        <DialogContent className="py-0">
          <div class="space-y-4">
            <div>
              <label class="mb-1 block text-sm font-medium text-neutral-600">
                File name
              </label>
              <Input
                value={exportOptions.fileName || tableName}
                onValueChange={(value) => setFileName(value, tableName)}
                placeholder={tableName}
                className="rounded-md border border-neutral-300 px-2 py-[6.25px] font-mono text-sm"
                disabled={exporting}
              />
              <p class="mt-1 text-xs text-neutral-500">Export as .{format}</p>
            </div>

            <div>
              <div class="mb-1 flex items-center justify-between">
                <label class="block text-sm font-medium text-neutral-600">
                  Select fields to export
                </label>
                <Button
                  variant="ghost"
                  onClick={selectAllColumns}
                  class="px-0 text-xs text-blue-600 hover:bg-transparent hover:underline"
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
                className="mb-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
              />
              <div class="max-h-40 overflow-y-auto rounded-md border border-neutral-300 bg-white py-1">
                {filteredColumnNames.length > 0 ? (
                  filteredColumnNames.map((name) => (
                    <label
                      key={name}
                      class={cn(
                        "flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-neutral-50",
                        exporting && "cursor-not-allowed opacity-50"
                      )}
                    >
                      <input
                        type="checkbox"
                        checked={selectedColumns.includes(name)}
                        onChange={() => handleSelectColumn(name)}
                        class="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
                        disabled={exporting}
                      />
                      <span class="font-mono text-neutral-800">{name}</span>
                    </label>
                  ))
                ) : (
                  <div class="flex items-center justify-center p-2 text-sm text-neutral-500">
                    No columns found. Try a different search.
                  </div>
                )}
              </div>
              <p class="mt-1 text-xs text-neutral-500">
                {selectedColumns.length === columnNames.length
                  ? "All fields selected"
                  : `${selectedColumns.length} of ${columnNames.length} columns selected`}
              </p>
            </div>

            <div>
              <label class="mb-1 block text-sm font-medium text-neutral-600">
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
                {["csv", "json", "sql"].map((name) => (
                  <option value={name} disabled={exporting}>
                    {name}
                  </option>
                ))}
              </Select>
            </div>

            {progress && (
              <div class="rounded-md border border-neutral-200 bg-neutral-50/80 p-3 text-xs">
                <div class="space-y-2">
                  <div class="flex items-center justify-between gap-2">
                    <p class="min-w-0 truncate font-medium text-neutral-800">
                      {exportOptions.fileName || tableName}.{format}
                    </p>
                    <span class="shrink-0 text-neutral-500 tabular-nums">
                      {progress.exported} / {totalRows} rows
                    </span>
                  </div>
                  <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
                    <div
                      class="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
                      style={{ width: `${Math.min(100, progressPct)}%` }}
                    />
                  </div>
                  {progress.exported === totalRows && (
                    <p class="text-right text-green-600">Completed!</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={exporting}>
            Cancel
          </Button>
          <Button
            variant="default"
            class="border border-blue-500"
            onClick={onExport}
            disabled={exporting || columnNames.length === 0}
          >
            {exporting ? "Exporting…" : "Export…"}
          </Button>
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
