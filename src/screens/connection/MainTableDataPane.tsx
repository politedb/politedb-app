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
} from "src/components/common/Dialog";
import { useTableFilter } from "src/components/table/tableHooks";

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

  const [viewMode, setViewMode] = useState<TableViewMode>("data");
  const [, forceUpdate] = useState(0);
  const [sqlPreview, setSqlPreview] = useState("");
  const [sqlDialogOpen, setSqlDialogOpen] = useState(false);

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

  const totalRows = offset + pageTotal;

  const getRowAt = (i: number) =>
    useConnectionStore.getState().getRowAt(activeKey, offset + i);

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
    </div>
  );
}
