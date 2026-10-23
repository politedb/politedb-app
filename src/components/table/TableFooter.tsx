import { useCallback, useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsLeftIcon,
  ChevronsRightIcon,
  PlusIcon,
} from "src/components/icons";
import { TableViewMode, TableViewToggle } from "./TableViewToggle";
import { Select } from "src/components/common/Select";
import { StructPaneTab } from "src/screens/connection/table/MainTableDataPane";
import { cn } from "src/utils/cn";
import { Checkbox } from "src/components/common/Checkbox";
import { Popover } from "src/components/common/Popover";

interface Props {
  filterBarVisible: boolean;
  limit: number;
  offset: number;

  // total rows (rowCount if known, else whatever you pass today)
  totalRows: number;
  rowCountIsEstimated?: boolean;

  // ✅ rows stream progress (global row index max loaded so far)
  loadedMax?: number;

  structPaneTab: StructPaneTab;
  viewMode: TableViewMode;
  onViewModeChange: (mode: TableViewMode) => void;
  onPageChange: (limit: number, offset: number) => void;
  onCountExact?: (includeFilters: boolean) => void | Promise<void>;
  onAddColumn: () => void;
  onAddIndex: () => void;
  onAddRow: () => void;
  canAddRow?: boolean;
  onFilters: () => void;
  /** Applied filter conditions, shown on the Filters button. */
  appliedFilterCount?: number;
  onExport?: () => void;
  readOnly?: boolean;
  className?: string;

  // Optional UI flags (for reuse outside table view)
  showViewToggle?: boolean;
  showActions?: boolean;
  showFiltersAndPaging?: boolean;
}

const PAGE_SIZE_OPTIONS = [50, 100, 300, 500, 1000];
const numberFormatter = new Intl.NumberFormat("en-US");

export function TableFooter({
  filterBarVisible,
  limit,
  offset,
  totalRows,
  rowCountIsEstimated = false,
  loadedMax,
  viewMode,
  structPaneTab,
  onViewModeChange,
  onPageChange,
  onCountExact,
  onAddColumn,
  onAddIndex,
  onAddRow,
  canAddRow = true,
  onFilters,
  appliedFilterCount = 0,
  onExport,
  readOnly = false,
  showViewToggle = true,
  showActions = true,
  showFiltersAndPaging = true,
  className,
}: Props) {
  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const [countBusy, setCountBusy] = useState(false);
  const [includeFilters, setIncludeFilters] = useState(true);

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

  // An estimated total can be lower than the real one: while the current page
  // is full, there may be another page after the estimate's last one.
  const pageFull =
    typeof loadedMax === "number" && loadedMax + 1 >= offset + limit;
  const hasNextPage =
    offset + limit < pagination.totalRows || (rowCountIsEstimated && pageFull);
  const lastPageOffset =
    pagination.totalRows > 0
      ? Math.floor((pagination.totalRows - 1) / limit) * limit
      : 0;

  const handlePageChange = useCallback(
    (newOffset: number) => {
      if (newOffset < 0 || newOffset === offset) return;
      // Only moving forward is bounded; any earlier page is reachable.
      if (
        newOffset > offset &&
        newOffset >= pagination.totalRows &&
        !hasNextPage
      ) {
        return;
      }
      onPageChange(limit, newOffset);
    },
    [limit, offset, pagination.totalRows, hasNextPage, onPageChange]
  );

  const handlePageSizeChange = (nextLimit: number) => {
    onPageChange(nextLimit, 0);
  };

  // ✅ Loaded label in the middle
  const loadedLabel = useMemo(() => {
    if (viewMode !== "data") return "";
    const formatNumber = (value: number) => numberFormatter.format(value);

    const totalPrefix = rowCountIsEstimated ? "~" : "";
    // Rows already loaded past a low (even zero) estimate count too.
    const shownTotal =
      rowCountIsEstimated && typeof loadedMax === "number"
        ? Math.max(totalRows, loadedMax + 1)
        : totalRows;

    // No matched rows (e.g. filter result is empty)
    if (shownTotal <= 0) {
      return "0 rows";
    }

    const totalPart =
      shownTotal > 0
        ? ` of ${totalPrefix}${formatNumber(shownTotal)} rows`
        : "";

    // Known total: always show the logical page window (e.g. 601-900 of 1,381).
    if (shownTotal > 0) {
      const start = offset + 1;
      const end = Math.min(offset + limit, shownTotal);
      if (end < start) {
        return rowCountIsEstimated
          ? `0 of ~${formatNumber(totalRows)} rows`
          : "0 rows";
      }
      return `${formatNumber(start)}-${formatNumber(end)}${totalPart}`;
    }

    // Unknown total: fall back to streamed row count for the current window.
    if (typeof loadedMax !== "number" || loadedMax < 0) {
      return "0 rows";
    }

    const pageStart = offset + 1;
    const pageEnd = Math.min(offset + limit, loadedMax + 1);
    if (pageEnd < pageStart) {
      return `${formatNumber(loadedMax + 1)} rows`;
    }

    return `${formatNumber(pageStart)}-${formatNumber(pageEnd)} rows`;
  }, [viewMode, loadedMax, offset, limit, totalRows, rowCountIsEstimated]);

  const handleCountConfirm = useCallback(async () => {
    if (!onCountExact) return;
    try {
      setCountBusy(true);
      await onCountExact(includeFilters);
    } finally {
      setCountBusy(false);
    }
  }, [onCountExact, includeFilters]);

  return (
    <div
      class={cn(
        "flex items-center justify-between gap-2 border-t border-neutral-200 bg-neutral-50 p-2",
        className
      )}
    >
      <div class="flex items-center gap-1.5">
        {showViewToggle && (
          <TableViewToggle
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
          />
        )}

        {showActions && viewMode === "structure" && (
          <>
            {structPaneTab === "columns" ? (
              <Button
                variant="shadow"
                className="px-2 py-0.75 text-sm"
                onClick={onAddColumn}
                disabled={readOnly}
              >
                <PlusIcon className="size-3" />
                Column
              </Button>
            ) : structPaneTab === "constraints" ? (
              <Button
                variant="shadow"
                className="px-2 py-0.75 text-sm"
                onClick={onAddIndex}
                disabled={readOnly}
              >
                <PlusIcon className="size-3" />
                Index
              </Button>
            ) : null}
          </>
        )}

        {showActions && viewMode === "data" && canAddRow && (
          <Button
            variant="shadow"
            className="px-2 py-0.75 text-sm"
            onClick={onAddRow}
            disabled={readOnly}
          >
            <PlusIcon className="size-3" />
            Row
          </Button>
        )}
      </div>

      {/* CENTER */}
      {viewMode === "data" && !(rowCountIsEstimated || countBusy) && (
        <div class="px-3 py-1 text-sm text-neutral-600 tabular-nums">
          {loadedLabel}
        </div>
      )}
      {viewMode === "data" && (rowCountIsEstimated || countBusy) && (
        <div class="flex items-center text-xs text-neutral-600 tabular-nums">
          <Popover
            open={isPopoverOpen}
            onOpenChange={setIsPopoverOpen}
            positions={["top", "bottom"]}
            align="center"
            padding={14}
            contentClassName="max-w-lg rounded-2xl border border-neutral-200 bg-white p-4 shadow-[0_8px_24px_rgba(0,0,0,0.16)]"
            content={
              <div>
                <div class="text-center text-sm font-medium text-neutral-800">
                  {countBusy ? "Counting..." : loadedLabel}
                </div>

                {(rowCountIsEstimated || countBusy) && (
                  <>
                    <p class="mt-2 text-sm text-orange-600">
                      The total is an estimate. Counting exactly reads the whole
                      table and can be slow on a large one.
                    </p>
                    <div class="mt-2 w-fit">
                      <Checkbox
                        checked={includeFilters}
                        onChange={(e) =>
                          setIncludeFilters(
                            (e.target as HTMLInputElement).checked
                          )
                        }
                        label="Include current filter conditions"
                        className="size-4 rounded-md"
                      />
                    </div>
                    <div class="mt-4 flex justify-center">
                      <Button
                        variant="shadow"
                        disabled={countBusy || !onCountExact}
                        onClick={async () => {
                          await handleCountConfirm();
                          setIsPopoverOpen(false);
                        }}
                      >
                        {countBusy ? "Counting..." : "Count"}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            }
          >
            <button
              type="button"
              onClick={() => setIsPopoverOpen((open) => !open)}
              aria-expanded={isPopoverOpen}
              aria-haspopup="dialog"
              title="Estimated total: count exactly"
              class="rounded-full px-3 py-1 text-sm transition-colors hover:bg-slate-100"
            >
              {loadedLabel}
            </button>
          </Popover>
        </div>
      )}

      {/* RIGHT */}
      {viewMode === "data" && showFiltersAndPaging && (
        <div class="flex items-center gap-2">
          {onExport ? (
            <Button variant="shadow" class="py-0.75 text-sm" onClick={onExport}>
              Export
            </Button>
          ) : null}
          <Button
            variant={filterBarVisible ? "default" : "shadow"}
            class={cn(
              "py-0.75 text-sm",
              filterBarVisible && "border border-blue-500"
            )}
            onClick={onFilters}
            aria-pressed={filterBarVisible}
            // The count says the rows are filtered even with the bar hidden.
            aria-label={
              appliedFilterCount > 0
                ? `Filters, ${appliedFilterCount} applied`
                : "Filters"
            }
          >
            Filters
            {appliedFilterCount > 0 ? (
              <span class="ml-1 rounded-full bg-blue-600 px-1.5 text-xs leading-4 text-white tabular-nums">
                {appliedFilterCount}
              </span>
            ) : null}
          </Button>
          <div class="flex items-center gap-0.5">
            <Button
              variant="shadow"
              onClick={() => handlePageChange(0)}
              disabled={offset === 0}
              className="h-6.75 px-2 py-1"
              title="First page"
              aria-label="First page"
            >
              <ChevronsLeftIcon className="size-4" />
            </Button>
            <Button
              variant="shadow"
              onClick={() => handlePageChange(Math.max(0, offset - limit))}
              disabled={offset === 0}
              className="h-6.75 px-3 py-1"
              title="Previous page"
              aria-label="Previous page"
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <Button
              variant="shadow"
              onClick={() => handlePageChange(offset + limit)}
              disabled={!hasNextPage}
              className="h-6.75 px-3 py-1"
              title="Next page"
              aria-label="Next page"
            >
              <ChevronRightIcon className="size-4" />
            </Button>
            <Button
              variant="shadow"
              onClick={() => handlePageChange(lastPageOffset)}
              // An estimate has no reliable last page.
              disabled={rowCountIsEstimated || offset >= lastPageOffset}
              className="h-6.75 px-2 py-1"
              title="Last page"
              aria-label="Last page"
            >
              <ChevronsRightIcon className="size-4" />
            </Button>
            <Select
              value={limit}
              onChange={(e: any) =>
                handlePageSizeChange(Number(e.target.value))
              }
              class="h-6.75"
              aria-label="Rows per page"
              title="Rows per page"
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
