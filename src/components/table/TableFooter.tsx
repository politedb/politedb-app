import { useCallback, useMemo } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { ChevronLeft, ChevronRight, Plus } from "src/components/icons";
import { TableViewMode, TableViewToggle } from "./TableViewToggle";
import { Select } from "src/components/common/Select";

interface Props {
  limit: number;
  offset: number;
  totalRows: number;
  viewMode: TableViewMode;
  onViewModeChange: (mode: TableViewMode) => void;
  onPageChange: (limit: number, offset: number) => void;
  onAddColumn: () => void;
  onAddIndex: () => void;
  onAddRow: () => void;
  onFilters: () => void;
}

export function TableFooter({
  limit,
  offset,
  totalRows,
  viewMode,
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
    [limit, offset, pagination.totalPages, onPageChange]
  );

  const handlePageSizeChange = (limit: number) => {
    onPageChange(limit, 0);
  };

  return (
    <div class="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-[9.25px]">
      <div class="flex items-center gap-1.5">
        <TableViewToggle
          viewMode={viewMode}
          onViewModeChange={onViewModeChange}
        />

        {viewMode === "structure" && (
          <>
            <Button variant="shadow" className="px-2" onClick={onAddIndex}>
              <Plus className="size-3.5" />
              Index
            </Button>
            <Button variant="shadow" className="px-2" onClick={onAddColumn}>
              <Plus className="size-3.5" />
              Column
            </Button>
          </>
        )}

        {viewMode === "data" && (
          <Button variant="shadow" className="px-2" onClick={onAddRow}>
            <Plus className="size-3.5" />
            Row
          </Button>
        )}
      </div>

      {viewMode === "data" && (
        <div class="flex items-center gap-2">
          <Button variant="shadow" onClick={onFilters}>
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
              <option value={50}>50</option>
              <option value={100}>100</option>
              <option value={300}>300</option>
              <option value={500}>500</option>
              <option value={1000}>1000</option>
            </Select>
          </div>
        </div>
      )}
    </div>
  );
}
