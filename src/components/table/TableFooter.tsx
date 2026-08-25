import { useCallback, useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  PlusIcon,
} from "src/components/icons";
import { TableViewMode, TableViewToggle } from "./TableViewToggle";
import { Select } from "src/components/common/Select";
import { StructPaneTab } from "src/screens/connection/MainTableDataPane";
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
    const formatNumber = (value: number) => numberFormatter.format(value);

    // No matched rows (e.g. filter result is empty)
    if (totalRows <= 0) {
      return "0 rows";
    }

    const totalPrefix = rowCountIsEstimated ? "~" : "";
    const totalPart =
      totalRows > 0 ? ` of ${totalPrefix}${formatNumber(totalRows)} rows` : "";

    // Known total: always show the logical page window (e.g. 601-900 of 1,381).
    if (totalRows > 0) {
      const start = offset + 1;
      const end = Math.min(offset + limit, totalRows);
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
      {viewMode === "data" && (
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
                    <p class="mt-2 text-sm text-orange-500">
                      This is the estimated value, click "Count" to retrieve the
                      exact value. It may affect your server performance
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
                        disabled={countBusy}
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
          <Button
            variant={filterBarVisible ? "default" : "shadow"}
            class={cn(
              "py-0.75 text-sm",
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
              className="h-6.75 px-3 py-1"
            >
              <ChevronLeftIcon className="size-4" />
            </Button>
            <Button
              variant="outline"
              onClick={() => handlePageChange(offset + limit)}
              disabled={offset + limit >= pagination.totalRows}
              className="h-6.75 px-3 py-1"
            >
              <ChevronRightIcon className="size-4" />
            </Button>
            <Select
              value={limit}
              onChange={(e: any) =>
                handlePageSizeChange(Number(e.target.value))
              }
              class="h-6.75 text-sm"
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
