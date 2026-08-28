import { useMemo } from "preact/hooks";
import { DbIcon } from "src/components/icons/DbIcon";
import { ClockIcon } from "src/components/icons";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { useInfiniteScroll } from "src/hooks/useInfiniteScroll";
import { useConnectionLogStore } from "src/stores/connectionLog";
import {
  connectionLogDisplayStatus,
  filterConnectionLogEntries,
  formatConnectionLogDateRange,
} from "src/utils/connectionLog";
import { cn } from "src/utils/cn";

const LOG_PAGE_SIZE = 10;

type Props = {
  searchQuery: string;
  onShowConnection?: (profileId: string) => void;
};

export function ConnectionLogsSection({
  searchQuery,
  onShowConnection,
}: Props) {
  const entries = useConnectionLogStore((s) => s.entries);

  const filteredEntries = useMemo(() => {
    const sorted = [...entries].sort((a, b) => b.openedAt - a.openedAt);
    return filterConnectionLogEntries(sorted, searchQuery);
  }, [entries, searchQuery]);

  const { visibleItems, sentinelRef, hasMore, totalCount } = useInfiniteScroll(
    filteredEntries,
    {
      pageSize: LOG_PAGE_SIZE,
      resetKey: `${searchQuery}:${filteredEntries.length}`,
    }
  );

  return (
    <div class="h-full w-full bg-neutral-100">
      <div class="mx-auto w-full max-w-400 px-6 py-5">
        <div class="mb-3 flex justify-between">
          <h2 class="text-sm font-semibold tracking-wide text-slate-800">
            Connection history ({totalCount})
          </h2>
        </div>

        <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {filteredEntries.length === 0 ? (
            <div class="px-6 py-14 text-center">
              <ClockIcon className="mx-auto mb-3 size-10 text-slate-300" />
              <p class="text-sm font-medium text-slate-800">
                {searchQuery.trim()
                  ? "No matching sessions"
                  : "No connection history yet"}
              </p>
              <p class="mt-1 text-sm text-slate-500">
                {searchQuery.trim()
                  ? "Try another search term."
                  : "Open a saved connection to record a session here."}
              </p>
            </div>
          ) : (
            <OverlayScrollArea horizontal vertical={false}>
              <table class="w-full min-w-200 border-collapse text-left text-sm">
                <thead>
                  <tr class="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    <th class="p-3">Date</th>
                    <th class="p-3">Status</th>
                    <th class="p-3">Device</th>
                    <th class="p-3">Host</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleItems.map((entry) => {
                    const displayStatus = connectionLogDisplayStatus(
                      entry.status
                    );
                    const isFailed = displayStatus === "failed";

                    return (
                      <tr
                        key={entry.id}
                        class={cn(
                          "border-b border-slate-100 transition-colors",
                          "hover:bg-slate-50/80"
                        )}
                      >
                        <td class="px-3 py-2 align-top text-slate-700 tabular-nums">
                          <div class="font-medium text-slate-900">
                            {formatConnectionLogDateRange(
                              entry.openedAt,
                              entry.closedAt
                            )}
                          </div>
                        </td>
                        <td class="px-3 py-2 align-top">
                          <span
                            class={cn(
                              "inline-flex rounded-md px-2 py-0.5 text-xs font-semibold capitalize",
                              isFailed
                                ? "bg-red-50 text-red-700"
                                : "bg-emerald-50 text-emerald-700"
                            )}
                          >
                            {displayStatus}
                          </span>
                        </td>
                        <td class="px-3 py-2 align-top">
                          <div class="font-medium">{entry.deviceName}</div>
                        </td>
                        <td class="px-3 py-2 align-top">
                          <button
                            type="button"
                            class={cn(
                              "flex w-full items-start gap-2 text-left",
                              "-mx-1 rounded-lg px-1 py-0.5",
                              onShowConnection && "hover:bg-slate-100/80"
                            )}
                            onClick={() => onShowConnection?.(entry.profileId)}
                            disabled={!onShowConnection}
                            title={
                              onShowConnection
                                ? "Show connection in list"
                                : undefined
                            }
                          >
                            <DbIcon
                              engine={entry.engine}
                              className="mt-0.5 size-8! shrink-0"
                            />
                            <span class="min-w-0">
                              <span class="block truncate font-medium text-slate-900">
                                {entry.profileLabel}
                              </span>
                              <span class="mt-0.5 block truncate text-xs text-slate-500">
                                {entry.host}
                              </span>
                            </span>
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {hasMore ? (
                <div
                  ref={sentinelRef}
                  class="flex items-center justify-center border-t border-slate-100 px-4 py-3"
                >
                  <span class="text-xs text-slate-500">Loading more…</span>
                </div>
              ) : null}
            </OverlayScrollArea>
          )}
        </div>
      </div>
    </div>
  );
}
