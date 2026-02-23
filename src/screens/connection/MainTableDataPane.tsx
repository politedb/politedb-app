import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";

import { TableData } from "src/components/table/TableData";
import { TableFilterBar } from "src/components/table/TableFilterBar";
import { TableFooter } from "src/components/table/TableFooter";
import { TableStructurePane } from "src/components/table/TableStructurePane";
import { LoadingTableState } from "./LoadingTableState";
import { ErrorState } from "./ErrorState";

import { DATA_ACTIONS, DATA_KEYS } from "src/constant";
import { DataAction, DataKey, useConnectionStore } from "src/stores/connection";
import { useTableDataOperations } from "src/screens/connection/hooks/useTableDataOperations";
import { tableKey, useLoadTableData } from "src/hooks/useLoadTableData";
import { TableViewMode } from "src/components/table/TableViewToggle";
import { useConnectionRuntimeCtx } from "./ConnectionRuntimeContext";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "src/components/common/Dialog";
import { useTableFilter } from "src/components/table/tableHooks";
import { parseCsv } from "src/utils/csv";
import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { runSqlQuery } from "src/lib/tauri/query";
import { ExportTableDialog } from "src/components/modal/ExportTableDialog";
import { useExportTableData } from "src/hooks/useExportTableData";

/* =============================================================================
 * Patch helpers
 * ============================================================================= */

type RowPatch = Record<string, any>;
type WindowPatches = Partial<
  Record<DataAction, Partial<Record<DataKey, Record<string, RowPatch>>>>
>;

const EMPTY_META = {
  columns: null,
  structure: null,
  constraints: null,
  sizeInfo: null,
  rowCount: null,
  busy: false,
  error: null,
};

const EMPTY_ARRAY: any[] = [];
const EMPTY_SET = new Set<number>();

function extractPatches(patches: WindowPatches | null) {
  if (!patches) return null;
  const res: Record<string, any> = {};
  Object.assign(res, patches.update?.data, patches.create?.data);
  return Object.keys(res).length ? res : null;
}

function extractDeleted(patches: WindowPatches | null, key: DataKey) {
  if (!patches) return EMPTY_SET;
  const map = patches.delete?.[key] ?? {};
  const out = new Set<number>();
  for (const k of Object.keys(map)) {
    const i = Number(k);
    if (!Number.isNaN(i)) out.add(i);
  }
  return out;
}

/* =============================================================================
 * Component
 * ============================================================================= */

export function MainTableDataPane(props: {
  activeTableWindow: {
    id: string;
    table: { schema: string; name: string };
  };

  // pagination from outer layer (actions ctx)
  pageChange: (limit: number, offset: number) => void;

  // ✅ wire real actions (no stubs)
  onAddColumn: () => void;
  onDeleteColumn: (rowIndex: number) => void;
  onAddIndex: () => void;
  onDeleteIndex: (rowIndex: number) => void;
  onFilters: () => void;
}) {
  const {
    activeTableWindow,
    pageChange,
    onAddColumn,
    onDeleteColumn,
    onAddIndex,
    onDeleteIndex,
  } = props;

  const rt = useConnectionRuntimeCtx();
  const { profileId, engine, limit, offset } = rt;

  const { loadTableData } = useLoadTableData();
  const { setProgress, setExportOptions } = useExportTableData();

  const [viewMode, setViewMode] = useState<TableViewMode>("data");
  const [, forceUpdate] = useState(0);
  const [sqlPreview, setSqlPreview] = useState("");
  const [sqlDialogOpen, setSqlDialogOpen] = useState(false);
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importPreview, setImportPreview] = useState<{
    headers: string[];
    rows: string[][];
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);

  const rerender = () => forceUpdate((n) => n + 1);

  const startedRef = useRef<string | null>(null);

  const {
    filterBarVisible,
    filters,
    filterCombine,
    appliedFilters,
    appliedFilterCombine,
    setFilters,
    setFilterCombine,
    setFilterBarVisible,
    handleApplyFilters,
    handleClearFilters,
  } = useTableFilter(startedRef);

  const activeKey = useMemo(
    () =>
      tableKey(
        profileId,
        activeTableWindow.table.schema,
        activeTableWindow.table.name
      ),
    [profileId, activeTableWindow]
  );

  /* ===========================================================================
   * Subscribe minimal state
   * =========================================================================== */

  const handleLoadRows = useCallback(async () => {
    const effectiveKey = `${activeKey}:${limit}:${offset}:${appliedFilters.length}:${appliedFilterCombine}`;
    if (startedRef.current === effectiveKey) return;
    startedRef.current = effectiveKey;

    useConnectionStore.getState().initRows(activeKey, 5000);

    // Always refetch when filter state changes so cache matches current filters.
    // (If we had filters and then cleared, cache would still hold filtered rows.)
    await loadTableData(
      activeTableWindow.table.schema,
      activeTableWindow.table.name,
      { limit, offset },
      {
        force: true,
        refreshRows: true,
        refreshMeta: false,
        refreshStats: false,
        filters: appliedFilters.length ? appliedFilters : undefined,
        filterCombine: appliedFilterCombine,
      }
    );
  }, [
    activeTableWindow,
    activeKey,
    limit,
    offset,
    appliedFilters,
    appliedFilterCombine,
  ]);

  useEffect(() => {
    if (!activeKey) return;

    handleLoadRows();

    let last = "";

    const unsub = useConnectionStore.subscribe((s) => {
      const meta = s.tableDataMap[activeKey];
      const rows = s.getRowsWindowInfo(activeKey);
      const sig = JSON.stringify([
        meta?.error,
        meta?.columns?.length,
        meta?.rowCount,
        rows?.version,
        rows?.running,
        rows?.loadedMax,
        rows?.streamOffset,
      ]);

      if (sig !== last) {
        last = sig;
        rerender();
      }
    });

    return unsub;
  }, [activeKey, handleLoadRows]);

  /* ===========================================================================
   * Snapshots
   * =========================================================================== */

  const meta =
    useConnectionStore.getState().tableDataMap[activeKey] ?? EMPTY_META;
  const rowsInfo =
    useConnectionStore.getState().getRowsWindowInfo(activeKey) ?? null;

  const patches =
    useConnectionStore.getState().dataPatchMap[profileId]?.[
      activeTableWindow.id
    ]?.patches ?? null;

  const hasError = !!(meta.error || rowsInfo?.error);
  const errorText = String(meta.error || rowsInfo?.error || "");

  /* ===========================================================================
   * Row state
   * =========================================================================== */

  const rowsRunning = !!rowsInfo?.running;
  const streamOffset = rowsInfo?.streamOffset ?? 0;
  const loadedMax = rowsInfo?.loadedMax ?? -1;

  const hasAnyRowData = useMemo(() => {
    if (loadedMax >= streamOffset) return true;
    const base = rowsInfo?.base ?? 0;
    for (let i = 0; i < 5; i++) {
      if (useConnectionStore.getState().getRowAt(activeKey, base + i))
        return true;
    }
    return false;
  }, [loadedMax, streamOffset, activeKey]);

  const rowsKnownEmpty = !!rowsInfo && !rowsRunning && loadedMax < streamOffset;

  const shouldShowLoading =
    !hasError && !hasAnyRowData && !rowsKnownEmpty && rowsRunning;

  /* ===========================================================================
   * Mutations
   * =========================================================================== */

  const onDataChange = useCallback(
    (
      action: DataAction,
      dataKey: DataKey,
      rowIndex: number,
      data: Record<string, any>
    ) => {
      const rowKey =
        rowIndex === -1 && data.__rowKey
          ? String(data.__rowKey)
          : String(rowIndex);

      // Update patches for UI consistency (but not for creates, since they're handled by store)
      useConnectionStore.getState().setDataPatchMap(profileId, {
        dataKey,
        action,
        tableData: meta,
        tableWindow: activeTableWindow as any,
        rowKey,
        data,
      });

      // Convert row key to number
      const rowIdx = Number(rowKey);

      // Update existing row
      const existingRow = useConnectionStore
        .getState()
        .getRowAt(activeKey, rowIdx);
      if (!existingRow) return;

      // Create updated row by copying existing data and updating the changed column
      const updatedRow = [...existingRow];
      const columns = meta.columns ?? [];

      // Find the column that was changed and update it
      for (const [colName, newValue] of Object.entries(data)) {
        if (colName === "__rowKey") continue; // Skip internal row key

        const colIndex = columns.findIndex((col) => col.name === colName);
        if (colIndex >= 0) {
          updatedRow[colIndex] = newValue;
        }
      }

      // Update the row in the store
      useConnectionStore.getState().updateRow(activeKey, rowIdx, updatedRow);
    },
    [profileId, meta, activeTableWindow, activeKey]
  );

  const { handleAddRow } = useTableDataOperations({ activeKey, onDataChange });

  const handleDeleteRow = useCallback(
    (rowIndex: number) => {
      const rowKey = String(rowIndex);
      const store = useConnectionStore.getState();
      const windowPatches =
        store.dataPatchMap[profileId]?.[activeTableWindow.id]?.patches ?? null;

      // If this row is a new row (only in create patch), remove the create patch
      // and the row from the store so we don't generate INSERT + DELETE SQL
      if (windowPatches?.create?.data?.[rowKey]) {
        store.removeDataPatch(
          profileId,
          activeTableWindow.id,
          DATA_ACTIONS.create,
          DATA_KEYS.data,
          rowKey
        );
        const globalRowIndex = offset + rowIndex;
        store.removeRow(activeKey, globalRowIndex);
        return;
      }

      onDataChange(DATA_ACTIONS.delete, DATA_KEYS.data, rowIndex, {});
    },
    [onDataChange, profileId, activeTableWindow.id, activeKey, offset]
  );

  /* ===========================================================================
   * Render guards
   * =========================================================================== */

  if (hasError) return <ErrorState message={errorText} />;
  if (shouldShowLoading) return <LoadingTableState />;

  /* ===========================================================================
   * Paging
   * =========================================================================== */

  const basePageTotal = useMemo(() => {
    if (typeof meta.rowCount === "number") {
      return Math.min(limit, Math.max(0, meta.rowCount - offset));
    }
    return limit;
  }, [meta.rowCount, limit, offset]);

  const pageTotal = useMemo(() => {
    if (!rowsInfo) return 0;

    const storeRows =
      rowsInfo.loadedMax >= rowsInfo.streamOffset
        ? rowsInfo.loadedMax - rowsInfo.streamOffset + 1
        : 0;

    return Math.max(basePageTotal, storeRows);
  }, [rowsInfo, basePageTotal]);

  const totalRows = useMemo(() => {
    if (typeof rowsInfo?.loadedMax !== "number" || rowsInfo.loadedMax < 0) {
      return 0;
    }

    return typeof meta.rowCount === "number"
      ? meta.rowCount
      : offset + pageTotal;
  }, [meta.rowCount, rowsInfo?.loadedMax, pageTotal, offset]);

  const getRowAt = (i: number) =>
    useConnectionStore.getState().getRowAt(activeKey, offset + i);

  /* ===========================================================================
   * Export / Import
   * =========================================================================== */

  const handleExport = useCallback(() => {
    const columns = meta.columns ?? [];
    if (columns.length === 0) return;
    const columnNames = columns.map((c) => c.name);
    setExportOptions((prev) => ({
      ...prev,
      format: "csv",
      fileName: activeTableWindow.table.name,
      columns: columnNames,
      csvOptions: prev.csvOptions || {},
      nullToEmpty: true,
    }));
    setProgress(null);
    setExportDialogOpen(true);
  }, [
    meta.columns,
    activeTableWindow.table.name,
    setExportOptions,
    setProgress,
    setExportDialogOpen,
  ]);

  const handleImport = useCallback(async () => {
    const path = await open({
      title: "Import table data",
      multiple: false,
      directory: false,
      filters: [{ name: "CSV", extensions: ["csv"] }],
    });
    if (!path || typeof path !== "string") return;
    setImportError(null);
    try {
      const text = await readTextFile(path);
      const { headers, rows } = parseCsv(text);
      if (headers.length === 0 || rows.length === 0) {
        setImportError("File has no headers or data rows.");
        setImportPreview({ headers, rows });
        setImportDialogOpen(true);
        return;
      }
      setImportPreview({ headers, rows });
      setImportDialogOpen(true);
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : "Failed to read file."
      );
      setImportPreview(null);
      setImportDialogOpen(true);
    }
  }, []);

  const handleImportConfirm = useCallback(async () => {
    if (!importPreview || importPreview.rows.length === 0) {
      setImportDialogOpen(false);
      return;
    }
    const columns = meta.columns ?? [];
    const tableCols = columns.map((c) => c.name);
    const headerToIndex = new Map(
      importPreview.headers.map((h, i) => [h.trim(), i])
    );
    const colOrder = tableCols.filter((name) => headerToIndex.has(name));
    if (colOrder.length === 0) {
      setImportError("No CSV columns match table columns.");
      return;
    }
    const connId = meta.connectionId;
    if (!connId) {
      setImportError("Not connected.");
      return;
    }
    setImportBusy(true);
    setImportError(null);
    const schema = activeTableWindow.table.schema;
    const tableName = activeTableWindow.table.name;
    const quotedTable = `"${schema.replace(/"/g, '""')}"."${tableName.replace(/"/g, '""')}"`;
    const quotedCols = colOrder
      .map((c) => `"${c.replace(/"/g, '""')}"`)
      .join(", ");
    const escape = (v: string) => `'${String(v).replace(/'/g, "''")}'`;

    const BATCH = 50;
    try {
      for (let i = 0; i < importPreview.rows.length; i += BATCH) {
        const batch = importPreview.rows.slice(i, i + BATCH);
        const values = batch
          .map((row) => {
            const vals = colOrder.map((col) => {
              const idx = headerToIndex.get(col)!;
              const raw = row[idx] ?? "";
              return escape(raw);
            });
            return `(${vals.join(", ")})`;
          })
          .join(", ");
        const sql = `INSERT INTO ${quotedTable} (${quotedCols}) VALUES ${values}`;
        await runSqlQuery(connId, sql, { timeoutMs: 30_000 });
      }
      setImportDialogOpen(false);
      setImportPreview(null);
      startedRef.current = null;
      await loadTableData(
        schema,
        tableName,
        { limit, offset },
        {
          force: true,
          refreshRows: true,
          refreshMeta: false,
          refreshStats: false,
        }
      );
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Import failed.");
    } finally {
      setImportBusy(false);
    }
  }, [
    importPreview,
    meta.columns,
    meta.connectionId,
    activeTableWindow.table.schema,
    activeTableWindow.table.name,
    loadTableData,
    limit,
    offset,
  ]);

  // When user chose Export/Import from table context menu in left nav
  useEffect(() => {
    if (!rt.pendingTableAction) return;
    const action = rt.pendingTableAction;
    const t = setTimeout(() => {
      if (action === "export") handleExport();
      else if (action === "import") handleImport();
      rt.setPendingTableAction(null);
    }, 80);
    return () => clearTimeout(t);
  }, [
    rt.pendingTableAction,
    rt.setPendingTableAction,
    handleExport,
    handleImport,
  ]);

  /* ===========================================================================
   * Render
   * =========================================================================== */

  return (
    <div class="flex h-full min-h-0 flex-col">
      <div class="min-h-0 flex-1 overflow-hidden">
        {viewMode === "structure" ? (
          <TableStructurePane
            engine={engine}
            profileId={profileId}
            activeTableWindow={activeTableWindow as any}
            activeTableMeta={meta}
            tableStructure={
              useConnectionStore.getState().tableStructure[profileId]?.[
                activeTableWindow.id
              ] ?? EMPTY_ARRAY
            }
            tableConstraints={
              useConnectionStore.getState().tableConstraints[profileId]?.[
                activeTableWindow.id
              ] ?? EMPTY_ARRAY
            }
            onDataChange={onDataChange}
            onAddNewColumn={onAddColumn}
            onDeleteColumn={onDeleteColumn}
            deletedStructureRows={extractDeleted(patches, DATA_KEYS.structure)}
            onAddIndex={onAddIndex}
            onDeleteIndex={onDeleteIndex}
            deletedConstraintRows={extractDeleted(
              patches,
              DATA_KEYS.constraints
            )}
          />
        ) : (
          <>
            {filterBarVisible && (
              <TableFilterBar
                schema={activeTableWindow.table.schema}
                tableName={activeTableWindow.table.name}
                columns={meta.columns ?? []}
                filters={filters}
                filterCombine={filterCombine}
                limit={limit}
                offset={offset}
                onFiltersChange={setFilters}
                onFilterCombineChange={setFilterCombine}
                onApply={handleApplyFilters}
                onClear={handleClearFilters}
                onExport={handleExport}
                onImport={handleImport}
                onShowSql={(sql) => {
                  setSqlPreview(sql);
                  setSqlDialogOpen(true);
                }}
              />
            )}
            <TableData
              columns={meta.columns ?? []}
              baseRows={hasAnyRowData ? basePageTotal : 0}
              totalRows={hasAnyRowData ? pageTotal : 0}
              getRowAt={getRowAt}
              onCellChange={onDataChange}
              patches={extractPatches(patches)}
              onAddRow={() =>
                handleAddRow(meta.columns ?? [], pageTotal, onDataChange)
              }
              onDeleteRow={handleDeleteRow}
              deletedRows={extractDeleted(patches, DATA_KEYS.data)}
              rowsVersion={rowsInfo?.version ?? 0}
            />
          </>
        )}
      </div>

      <TableFooter
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        limit={limit}
        offset={offset}
        loadedMax={loadedMax}
        totalRows={totalRows}
        onPageChange={pageChange}
        onAddRow={() =>
          handleAddRow(meta.columns ?? [], pageTotal, onDataChange)
        }
        onAddColumn={onAddColumn}
        onAddIndex={onAddIndex}
        onFilters={() => setFilterBarVisible((v) => !v)}
      />

      <Dialog
        open={sqlDialogOpen}
        onClose={() => setSqlDialogOpen(false)}
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>SQL Preview</DialogTitle>
        </DialogHeader>
        <DialogContent>
          <div class="rounded border border-neutral-200 bg-neutral-100 p-2 font-mono text-xs break-all whitespace-pre-wrap">
            {sqlPreview}
          </div>
        </DialogContent>
      </Dialog>

      <ExportTableDialog
        open={exportDialogOpen}
        handleClose={() => setExportDialogOpen(false)}
        connectionId={meta.connectionId}
        schema={activeTableWindow.table.schema}
        tableName={activeTableWindow.table.name}
        columns={meta.columns ?? []}
        totalRows={totalRows}
        appliedFilters={appliedFilters}
        appliedFilterCombine={appliedFilterCombine}
      />

      <Dialog
        open={importDialogOpen}
        onClose={() => {
          if (!importBusy) {
            setImportDialogOpen(false);
            setImportPreview(null);
            setImportError(null);
          }
        }}
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>Import data</DialogTitle>
        </DialogHeader>
        <DialogContent>
          {importError && (
            <p class="mb-2 text-sm text-red-600">{importError}</p>
          )}
          {importPreview && (
            <>
              <p class="mb-2 text-xs text-neutral-600">
                {importPreview.headers.length} columns,{" "}
                {importPreview.rows.length} rows. First 5 rows:
              </p>
              <div class="max-h-48 overflow-auto rounded border border-neutral-200 font-mono text-xs">
                <table class="w-full border-collapse">
                  <thead class="sticky top-0 bg-neutral-100">
                    <tr>
                      {importPreview.headers.map((h) => (
                        <th
                          key={h}
                          class="border border-neutral-200 px-2 py-1 text-left"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.rows.slice(0, 5).map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            class="max-w-[120px] truncate border border-neutral-200 px-2 py-1"
                            title={cell}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </DialogContent>
        <DialogFooter>
          <button
            type="button"
            class="rounded border border-neutral-300 bg-white px-3 py-1.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50"
            onClick={() => {
              setImportDialogOpen(false);
              setImportPreview(null);
              setImportError(null);
            }}
            disabled={importBusy}
          >
            Cancel
          </button>
          {importPreview && importPreview.rows.length > 0 && (
            <button
              type="button"
              class="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              onClick={handleImportConfirm}
              disabled={importBusy}
            >
              {importBusy ? "Importing…" : "Import"}
            </button>
          )}
        </DialogFooter>
      </Dialog>
    </div>
  );
}
