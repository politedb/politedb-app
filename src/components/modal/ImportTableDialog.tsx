import { useCallback, useMemo } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "src/components/common/Dialog";
import { DataImportPreview } from "src/hooks/useImportTableData";
import { Button } from "src/components/common/Button";
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
  handleClose: () => void;
  onImport: () => void;
}

/** Normalize rows to header length so every row has exactly one cell per column. */
function previewTableData(preview: DataImportPreview, firstIsHeaders: boolean) {
  const { headers, rows } = preview;

  const displayedRows = firstIsHeaders
    ? [headers, ...rows.slice(0, 100)]
    : rows.slice(0, 100);

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
  handleClose,
  onImport,
}: Props) {
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
    return previewTableData(dataPreview, true);
  }, [dataPreview]);

  return (
    <>
      <Dialog open={open} onClose={onClose} size="lg">
        <DialogHeader>
          <DialogTitle className="text-base">Import CSV data</DialogTitle>
        </DialogHeader>
        <DialogContent className="py-0">
          {dataPreview && (
            <>
              <p class="text-sm font-medium">
                Table: {schema}.{tableName}
              </p>
              <p class="text-xs text-neutral-600">
                First 100 rows of the CSV file
              </p>
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
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={importing}>
            Cancel
          </Button>
          {dataPreview && dataPreview.rows.length > 0 && (
            <Button
              variant="default"
              class="border border-blue-500"
              onClick={onImport}
              disabled={importing}
            >
              {importing ? "Importing…" : "Import"}
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
