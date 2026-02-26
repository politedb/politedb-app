import { useCallback, useMemo, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "src/components/common/Dialog";
import { DataImportPreview } from "src/hooks/useImportTableData";
import { Button } from "src/components/common/Button";
import { Checkbox } from "src/components/common/Checkbox";
import { Table } from "src/components/common/Table";
import { ErrorDialog } from "./ErrorDialog";
import type { ColumnMeta } from "src/lib/tauri/types";

interface Props {
  open: boolean;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  dataPreview: DataImportPreview | null;
  error: string | null;
  importing: boolean;
  progress: { imported: number; total: number } | null;
  handleClose: () => void;
  onImport: (firstIsHeaders: boolean) => void;
}

/** Normalize rows to header length so every row has exactly one cell per column. */
function previewTableData(preview: DataImportPreview, firstIsHeaders: boolean) {
  const { headers, rows } = preview;

  const displayedRows = firstIsHeaders
    ? rows.slice(0, 100)
    : [headers, ...rows.slice(0, 100)];

  const data: Record<string, string>[] = displayedRows.map((row) => {
    const obj: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) {
      obj[`col_${i}`] = row[i] ?? "";
    }
    return obj;
  });
  return data;
}

export function ImportTableDialog({
  open,
  schema,
  tableName,
  columns,
  dataPreview,
  error,
  importing,
  progress,
  handleClose,
  onImport,
}: Props) {
  const [firstIsHeaders, setFirstIsHeaders] = useState(true);

  const onClose = useCallback(() => {
    if (importing) return;
    handleClose();
  }, [importing, handleClose]);

  const tableColumns = useMemo(() => {
    return columns.map((col, i) => ({
      key: `col_${i}`,
      label: col.name,
      className: "max-w-38 py-1.5 truncate font-mono text-xs",
      render: (value: string) => (
        <span class="block truncate" title={value ?? ""}>
          {value ?? ""}
        </span>
      ),
    }));
  }, [columns]);

  const tableData = useMemo(() => {
    if (!dataPreview) return [];
    return previewTableData(dataPreview, firstIsHeaders);
  }, [dataPreview, firstIsHeaders]);

  const progressPct = useMemo(() => {
    if (!progress || progress.total === 0) return 0;
    return (progress.imported / progress.total) * 100;
  }, [progress]);

  return (
    <>
      <Dialog open={open} onClose={onClose} size={progress ? "sm" : "lg"}>
        <DialogHeader>
          <DialogTitle className="text-base">Import CSV data</DialogTitle>
        </DialogHeader>
        <DialogContent className="py-0">
          {dataPreview && (
            <>
              <div class="space-y-2">
                <p class="flex items-center gap-2 text-sm font-medium">
                  Table{" "}
                  <span class="rounded border border-neutral-200 px-2 py-0.5 font-mono text-xs shadow">
                    {schema}.{tableName}
                  </span>
                </p>
                <div class="flex items-center gap-6">
                  <p class="text-xs text-neutral-600">
                    First 100 rows of the CSV file
                  </p>
                  <Checkbox
                    checked={firstIsHeaders}
                    onChange={(e) =>
                      setFirstIsHeaders((e.target as HTMLInputElement).checked)
                    }
                    label="First row is headers"
                  />
                </div>
              </div>

              <div class="max-h-48 overflow-auto rounded border border-neutral-200">
                <Table
                  columns={tableColumns}
                  data={tableData}
                  showEmptyMessage={true}
                  keyExtractor={(_, i) => i}
                />
              </div>
              <p class="text-xs text-neutral-600">
                CSV {dataPreview.headers.length} columns,{" "}
                {dataPreview.rows.length} rows
              </p>
            </>
          )}

          {progress && (
            <div class="rounded-md border border-neutral-200 bg-neutral-50/80 p-3 text-xs">
              <div class="space-y-2">
                <div class="flex items-center justify-between gap-2">
                  <p class="min-w-0 truncate font-medium text-neutral-800">
                    {tableName}
                  </p>
                  <span class="shrink-0 text-neutral-500 tabular-nums">
                    {progress.imported} / {progress.total} rows
                  </span>
                </div>
                <div class="h-2 w-full overflow-hidden rounded-full bg-neutral-200">
                  <div
                    class="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-out"
                    style={{ width: `${Math.min(100, progressPct)}%` }}
                  />
                </div>
                {progress.imported === progress.total && (
                  <p class="text-right text-green-600">Completed!</p>
                )}
              </div>
            </div>
          )}
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          {dataPreview && (dataPreview.rows.length > 0 || !firstIsHeaders) && (
            <Button
              variant="default"
              class="border border-blue-500"
              onClick={() => onImport(firstIsHeaders)}
              disabled={importing}
            >
              {importing ? "Importing..." : "Import"}
            </Button>
          )}
        </DialogFooter>
      </Dialog>

      {error && (
        <ErrorDialog
          open={true}
          error={error}
          onClose={handleClose}
          size="md"
        />
      )}
    </>
  );
}
