import { useState } from "preact/hooks";
import type { TableViewMode } from "src/components/table/TableViewToggle";

export type StructPaneTab = "columns" | "constraints" | "foreignKeys";

export function useMainTablePaneState(args: { limit: number; offset: number }) {
  const { limit, offset } = args;

  const [viewMode, setViewMode] = useState<TableViewMode>("data");
  const [structPaneTab, setStructPaneTab] = useState<StructPaneTab>("columns");
  const [sqlPreview, setSqlPreview] = useState("");
  const [sqlDialogOpen, setSqlDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
  const [truncateDialogOpen, setTruncateDialogOpen] = useState(false);
  const [dropDialogOpen, setDropDialogOpen] = useState(false);
  const [progressNow, setProgressNow] = useState(() => Date.now());
  const [errorDialogOpen, setErrorDialogOpen] = useState(false);
  const [settledPagination, setSettledPagination] = useState(() => ({
    limit,
    offset,
  }));

  return {
    viewMode,
    setViewMode,
    structPaneTab,
    setStructPaneTab,
    sqlPreview,
    setSqlPreview,
    sqlDialogOpen,
    setSqlDialogOpen,
    importDialogOpen,
    setImportDialogOpen,
    exportDialogOpen,
    setExportDialogOpen,
    cloneDialogOpen,
    setCloneDialogOpen,
    truncateDialogOpen,
    setTruncateDialogOpen,
    dropDialogOpen,
    setDropDialogOpen,
    progressNow,
    setProgressNow,
    errorDialogOpen,
    setErrorDialogOpen,
    settledPagination,
    setSettledPagination,
  };
}
