import { useCallback, useMemo } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { ChevronLeft, ChevronRight, Plus } from "src/components/icons";
import { TableViewMode, TableViewToggle } from "./TableViewToggle";
import { Select } from "src/components/common/Select";
import { StructPaneTab } from "src/screens/connection/MainTableDataPane";
import { cn } from "src/utils/cn";

interface Props {
  filterBarVisible: boolean;
  limit: number;
  offset: number;

  // total rows (rowCount if known, else whatever you pass today)
  totalRows: number;

  // ✅ rows stream progress (global row index max loaded so far)
  loadedMax?: number;

  structPaneTab: StructPaneTab;
  viewMode: TableViewMode;
  onViewModeChange: (mode: TableViewMode) => void;
  onPageChange: (limit: number, offset: number) => void;
  onAddColumn: () => void;
  onAddIndex: () => void;
  onAddRow: () => void;
  onFilters: () => void;
}

const PAGE_SIZE_OPTIONS = [50, 100, 300, 500, 1000];

export function TableFooter({
  filterBarVisible,
  limit,
  offset,
  totalRows,
  loadedMax,
  viewMode,
  structPaneTab,
  onViewModeChange,
  onPageChange,
  onAddColumn,
  onAddIndex,
  onAddRow,
  onFilters,
}: Props) {
  // Calculate pagination
  const pagination = useMemo(() => {
    const startIndex = offset;
    const endIndex = startIndex + limit;

    return {
      totalRows,
      totalPages: Math.ceil(totalRows / limit),
      startIndex,
      endIndex,
    };
  }, [totalRows, limit, offset]);

  const handlePageChange = useCallback(
    (newOffset: number) => {
      if (newOffset >= 0 && newOffset < pagination.totalRows) {
        onPageChange(limit, newOffset);
      }
    },
    [limit, pagination.totalRows, onPageChange]
  );

  const handlePageSizeChange = (nextLimit: number) => {
    onPageChange(nextLimit, 0);
  };

  // ✅ Loaded label in the middle
  const loadedLabel = useMemo(() => {
    if (viewMode !== "data") return "";

    if (typeof loadedMax !== "number" || loadedMax < 0) {
      return "Rows loaded: 0";
    }

    // loadedMax is 0-based index => +1 rows count
    const loadedCount = loadedMax + 1;

    // show "x–y" for current page, based on loadedMax
    const start = offset + 1;
    const end = Math.min(offset + limit, loadedCount);

    if (end < start) return `Rows loaded: ${loadedCount}`;

    // If totalRows is unknown, you can pass 0. We won't show "of N".
    const totalPart = totalRows > 0 ? ` of ${totalRows}` : "";

    return `Rows loaded: ${start}–${end}${totalPart}`;
  }, [viewMode, loadedMax, offset, limit, totalRows]);

  return (
    <div class="flex items-center justify-between gap-2 border-t border-neutral-200 bg-neutral-50 px-4 py-[9.25px]">
      {/* LEFT */}
      <div class="flex items-center gap-1.5">
        <TableViewToggle
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        />

        {viewMode === "structure" && (
          <>
            {structPaneTab === "columns" ? (
              <Button variant="shadow" className="px-2" onClick={onAddColumn}>
                <Plus className="size-3.5" />
                Column
              </Button>
            ) : (
              <Button variant="shadow" className="px-2" onClick={onAddIndex}>
                <Plus className="size-3.5" />
                Index
              </Button>
            )}
          </>
        )}

        {viewMode === "data" && (
          <Button variant="shadow" className="px-2" onClick={onAddRow}>
            <Plus className="size-3.5" />
            Row
          </Button>
        )}
      </div>

      {/* CENTER */}
      {viewMode === "data" && (
        <div class="text-xs text-neutral-600 tabular-nums">{loadedLabel}</div>
      )}

      {/* RIGHT */}
      {viewMode === "data" && (
        <div class="flex items-center gap-2">
          <Button
            variant={filterBarVisible ? "default" : "shadow"}
            class={cn(
              "py-[2.5px]",
              filterBarVisible && "border border-blue-500"
            )}
            onClick={onFilters}
          >
            Filters
          </Button>
          <div class="flex items-center gap-0.5">
            <Button
              variant="outline"
              onClick={() => handlePageChange(offset - limit)}
              disabled={offset === 0}
              className="px-3 py-1"
            >
              <ChevronLeft className="size-3" />
            </Button>
            <Button
              variant="outline"
              onClick={() => handlePageChange(offset + limit)}
              disabled={offset + limit >= pagination.totalRows}
              className="px-3 py-1"
            >
              <ChevronRight className="size-3" />
            </Button>
            <Select
              value={limit}
              onChange={(e: any) =>
                handlePageSizeChange(Number(e.target.value))
              }
              class="h-fit px-2 py-1 text-sm"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option value={size}>{size}</option>
              ))}
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}
