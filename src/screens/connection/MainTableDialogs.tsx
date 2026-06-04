import { ExportTableDialog } from "src/components/modal/ExportTableDialog";
import { ImportTableDialog } from "src/components/modal/ImportTableDialog";
import { CloneTableDialog } from "src/components/modal/CloneTableDialog";
import { TruncateTableDialog } from "src/components/modal/TruncateTableDialog";
import { DropTableDialog } from "src/components/modal/DropTableDialog";
import { SqlPreviewModal } from "src/components/modal/SqlPreviewModal";
import { ErrorDialog } from "src/components/modal/ErrorDialog";
import type { DatabaseEngine } from "src/types";
import type { TableFilterCondition } from "src/lib/queries/sql";
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
  truncateDialogOpen: boolean;
  onTruncateClose: () => void;
  dropDialogOpen: boolean;
  onDropClose: () => void;
  errorDialogOpen: boolean;
  setErrorDialogOpen: (open: boolean) => void;
  hasError: boolean;
  activeKey: string;
  errorText: string;
  onErrorDismissPersist: (key: string, message: string) => void;
  connectionId: string | null;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  totalRows: number;
  appliedFilters: TableFilterCondition[];
  appliedFilterCombine: "AND" | "OR";
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
  handleTruncate: (opts: {
    restartIdentity: boolean;
    cascade: boolean;
  }) => Promise<void>;
  handleDrop: () => Promise<void>;
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
    truncateDialogOpen,
    onTruncateClose,
    dropDialogOpen,
    onDropClose,
    errorDialogOpen,
    setErrorDialogOpen,
    hasError,
    activeKey,
    errorText,
    onErrorDismissPersist,
    connectionId,
    schema,
    tableName,
    columns,
    totalRows,
    appliedFilters,
    appliedFilterCombine,
    engine,
    dataImportPreview,
    importError,
    importBusy,
    importProgressState,
    handleImport,
    handleClone,
    handleTruncate,
    handleDrop,
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
          totalRows={totalRows}
          appliedFilters={appliedFilters}
          appliedFilterCombine={appliedFilterCombine}
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

      {truncateDialogOpen && (
        <TruncateTableDialog
          open={truncateDialogOpen}
          onClose={onTruncateClose}
          tableName={tableName}
          onConfirm={handleTruncate}
        />
      )}

      {dropDialogOpen && (
        <DropTableDialog
          open={dropDialogOpen}
          onClose={onDropClose}
          tableName={tableName}
          onConfirm={handleDrop}
        />
      )}

      {errorDialogOpen && (
        <ErrorDialog
          open
          variant="execution"
          backdropClassName="bg-transparent"
          error={errorText}
          onClose={() => {
            setErrorDialogOpen(false);
            if (hasError) {
              onErrorDismissPersist(activeKey, errorText);
            }
          }}
        />
      )}
    </>
  );
}
