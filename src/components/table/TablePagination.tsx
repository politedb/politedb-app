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
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  setPageSize: (pageSize: number) => void;
}

export function TablePagination({
  pagination,
  page,
  pageSize,
  setPage,
  setPageSize,
}: Props) {
  const handlePageChange = (newPage: number) => {
    if (newPage >= 1 && newPage <= pagination.totalPages) {
      setPage(newPage);
    }
  };

  const handlePageSizeChange = (newPageSize: number) => {
    setPageSize(newPageSize);
    setPage(1); // Reset to first page when changing page size
  };

  return (
    <div class="flex items-center justify-between border-t border-neutral-200 bg-neutral-50 px-4 py-3">
      <div class="flex items-center gap-0.5">
        <div class="flex items-center gap-0.5 rounded-md bg-neutral-100 p-0.5">
          <Button
            variant="default"
            onClick={() => handlePageChange(page - 1)}
            className="px-3 py-1"
          >
            Data
          </Button>
          <Button
            variant="ghost"
            onClick={() => handlePageChange(page + 1)}
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
          onClick={() => handlePageChange(page - 1)}
          disabled={page === 1}
          className="px-3 py-1"
        >
          <ChevronLeft className="size-3" />
        </Button>
        <Button
          variant="outline"
          onClick={() => handlePageChange(page + 1)}
          disabled={page === pagination.totalPages}
          className="px-3 py-1"
        >
          <ChevronRight className="size-3" />
        </Button>
        <select
          value={pageSize}
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
