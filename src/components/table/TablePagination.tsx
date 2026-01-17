import { useCallback } from "preact/hooks";
import { Button } from "../common/Button";
import { ChevronLeft, ChevronRight } from "../icons";

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
  onPageChange: (limit: number, offset: number) => void;
}

export function TablePagination({
  pagination,
  limit,
  offset,
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
    <div class="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-3">
      <div class="flex items-center gap-0.5">
        <div class="flex items-center gap-0.5 rounded-md bg-neutral-100 p-0.5">
          <Button
            variant="default"
            onClick={() => handlePageChange(offset - limit)}
            className="px-3 py-1"
          >
            Data
          </Button>
          <Button
            variant="ghost"
            onClick={() => handlePageChange(offset + limit)}
            disabled
            className="px-3 py-1"
          >
            Structure
          </Button>
        </div>
      </div>

      <div class="flex items-center gap-2">
        <span class="text-sm text-neutral-600">
          Showing {pagination.startIndex + 1} to{" "}
          {Math.min(pagination.endIndex, pagination.totalRows)} of{" "}
          {pagination.totalRows} rows
        </span>
      </div>

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
