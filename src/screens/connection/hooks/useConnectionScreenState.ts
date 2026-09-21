import { useState } from "preact/hooks";
import { DEFAULT_LIMIT, DEFAULT_OFFSET } from "src/hooks/useLoadTableData";

export function useConnectionScreenState() {
  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [offset, setOffset] = useState(DEFAULT_OFFSET);
  const [pendingTableAction, setPendingTableAction] = useState<
    | "export"
    | "import"
    | "importSqlDump"
    | "clone"
    | "truncate"
    | "drop"
    | "structure"
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [snippetPickerOpen, setSnippetPickerOpen] = useState(false);
  const [diagramOpen, setDiagramOpen] = useState(false);
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);

  return {
    limit,
    setLimit,
    offset,
    setOffset,
    pendingTableAction,
    setPendingTableAction,
    error,
    setError,
    showSaveDialog,
    setShowSaveDialog,
    searchDialogOpen,
    setSearchDialogOpen,
    snippetPickerOpen,
    setSnippetPickerOpen,
    diagramOpen,
    setDiagramOpen,
    errorDialogOpen,
    setErrorDialogOpen,
  };
}
