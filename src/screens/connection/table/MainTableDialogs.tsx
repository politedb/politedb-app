import { ExportTableDialog } from "src/components/modal/ExportTableDialog";
import { ImportTableDialog } from "src/components/modal/ImportTableDialog";
import { CloneTableDialog } from "src/components/modal/CloneTableDialog";
import { SqlPreviewModal } from "src/components/modal/SqlPreviewModal";
import type { DatabaseEngine } from "src/types";
import type { TableConstraint } from "src/types";
import type { TableFilterCondition, TableSort } from "src/lib/queries/sql";
import type { ColumnMeta } from "src/lib/tauri/types";
import type {
  DataImportPreview,
  ImportColumnMapping,
  ImportNullMode,
} from "src/hooks/useImportTableData";

export function MainTableDialogs(props: {
  sqlDialogOpen: boolean;
  setSqlDialogOpen: (open: boolean) => void;
  sqlPreview: string;
  exportDialogOpen: boolean;
  setExportDialogOpen: (open: boolean) => void;
  importDialogOpen: boolean;
  onImportClose: () => void;
  cloneDialogOpen: boolean;
  onCloneClose: () => void;
  connectionId: string | null;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  constraints?: TableConstraint[] | null;
  totalRows: number;
  appliedFilters: TableFilterCondition[];
  appliedFilterCombine: "AND" | "OR";
  exportPagination?: { limit: number; offset: number };
  exportSortState?: TableSort | null;
  engine: DatabaseEngine;
  importError: string | null;
  importBusy: boolean;
  importProgressState: { imported: number; total: number } | null;
  handleImport: (options: {
    firstIsHeaders: boolean;
    columnMapping: ImportColumnMapping;
    nullMode: ImportNullMode;
    fullValidation: boolean;
  }) => Promise<void>;
  handleClone: (nextName: string, copyData: boolean) => Promise<void>;
  dataImportPreview: DataImportPreview | null;
}) {
  const {
    sqlDialogOpen,
    setSqlDialogOpen,
    sqlPreview,
    exportDialogOpen,
    setExportDialogOpen,
    importDialogOpen,
    onImportClose,
    cloneDialogOpen,
    onCloneClose,
    connectionId,
    schema,
    tableName,
    columns,
    constraints,
    totalRows,
    appliedFilters,
    appliedFilterCombine,
    exportPagination,
    exportSortState,
    engine,
    dataImportPreview,
    importError,
    importBusy,
    importProgressState,
    handleImport,
    handleClone,
  } = props;

  return (
    <>
      {sqlDialogOpen && (
        <SqlPreviewModal
          open={sqlDialogOpen}
          onClose={() => setSqlDialogOpen(false)}
          sqlPreview={sqlPreview}
        />
      )}

      {exportDialogOpen && (
        <ExportTableDialog
          open={exportDialogOpen}
          handleClose={() => setExportDialogOpen(false)}
          connectionId={connectionId}
          schema={schema}
          tableName={tableName}
          columns={columns}
          constraints={constraints}
          totalRows={totalRows}
          appliedFilters={appliedFilters}
          appliedFilterCombine={appliedFilterCombine}
          pagination={exportPagination}
          sortState={exportSortState}
          engine={engine}
        />
      )}

      {importDialogOpen && (
        <ImportTableDialog
          open={importDialogOpen}
          handleClose={onImportClose}
          schema={schema}
          tableName={tableName}
          columns={columns}
          dataPreview={dataImportPreview}
          error={importError}
          importing={importBusy}
          progress={importProgressState}
          onImport={handleImport}
        />
      )}

      {cloneDialogOpen && (
        <CloneTableDialog
          open={cloneDialogOpen}
          onClose={onCloneClose}
          sourceTableName={tableName}
          onConfirm={handleClone}
        />
      )}
    </>
  );
}
