import { useCallback } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { ChevronLeft, ChevronRight } from "src/components/icons";
import { TableViewMode, TableViewToggle } from "./TableViewToggle";

export type Pagination = {
  startIndex: number;
  endIndex: number;
  totalRows: number;
  totalPages: number;
};

interface Props {
  pagination: Pagination;
  limit: number;
  offset: number;
  viewMode: TableViewMode;
  onViewModeChange: (mode: TableViewMode) => void;
  onPageChange: (limit: number, offset: number) => void;
}

export function TablePagination({
  pagination,
  limit,
  offset,
  viewMode,
  onViewModeChange,
  onPageChange,
}: Props) {
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
      <TableViewToggle
        viewMode={viewMode}
        onViewModeChange={onViewModeChange}
      />

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
        <select
          value={limit}
          onChange={(e: any) => handlePageSizeChange(Number(e.target.value))}
          class="rounded-md border border-neutral-300 bg-white px-2 py-1 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none"
        >
          <option value={50}>50</option>
          <option value={100}>100</option>
          <option value={300}>300</option>
          <option value={500}>500</option>
          <option value={1000}>1000</option>
        </select>
      </div>
    </div>
  );
}
