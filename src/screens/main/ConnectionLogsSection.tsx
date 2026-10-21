import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { DbIcon } from "src/components/icons/DbIcon";
import {
  ClockIcon,
  CopyIcon,
  DatabaseIcon,
  PlayIcon,
  TrashIcon,
} from "src/components/icons";
import { Button } from "src/components/common/Button";
import { ContextMenu, type MenuItem } from "src/components/common/ContextMenu";
import { KebabButton } from "src/components/common/KebabButton";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { useInfiniteScroll } from "src/hooks/useInfiniteScroll";
import { confirmDialog } from "src/lib/system-dialog";
import { MAX_ENTRIES, useConnectionLogStore } from "src/stores/connectionLog";
import {
  collapseRepeatedSessions,
  connectionLogDisplayStatus,
  filterConnectionLogEntries,
  filterSessionsByStatus,
  formatSessionDuration,
  formatSessionTime,
  groupRowsByDay,
  hasSeveralDevices,
  splitSessionTarget,
  truncateMiddle,
  type ConnectionLogRow,
  type ConnectionLogStatusFilter,
} from "src/utils/connectionLog";
import { cn } from "src/utils/cn";

const LOG_PAGE_SIZE = 30;
/** Longest host shown before it is shortened in the middle. */
const MAX_ADDRESS = 48;
/** How often an open session's duration is refreshed. */
const OPEN_TICK_MS = 30_000;

type Props = {
  searchQuery: string;
  /** Selects the connection on the Connections page. */
  onShowConnection?: (profileId: string) => void;
  /** Opens the connection again in a new tab. */
  onOpenConnection?: (profileId: string) => void;
  /** Saved connections; sessions of deleted ones cannot be opened again. */
  knownProfileIds?: ReadonlySet<string>;
};

const STATUS_FILTERS: Array<{ id: ConnectionLogStatusFilter; label: string }> =
  [
    { id: "all", label: "All" },
    { id: "open", label: "Open" },
    { id: "failed", label: "Failed" },
  ];

export function ConnectionLogsSection({
  searchQuery,
  onShowConnection,
  onOpenConnection,
  knownProfileIds,
}: Props) {
  const entries = useConnectionLogStore((s) => s.entries);
  const clearLog = useConnectionLogStore((s) => s.clearLog);
  const [statusFilter, setStatusFilter] =
    useState<ConnectionLogStatusFilter>("all");
  const [profileFilter, setProfileFilter] = useState("all");

  const sorted = useMemo(
    () => [...entries].sort((a, b) => b.openedAt - a.openedAt),
    [entries]
  );
  const hasOpen = sorted.some((entry) => entry.status === "active");

  // Durations of open sessions keep counting.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!hasOpen) return;
    const id = window.setInterval(() => setNow(Date.now()), OPEN_TICK_MS);
    return () => window.clearInterval(id);
  }, [hasOpen, entries]);

  // Connections in the log, newest label first, for the connection filter.
  const connections = useMemo(() => {
    const seen = new Map<string, string>();
    for (const entry of sorted)
      if (!seen.has(entry.profileId))
        seen.set(entry.profileId, entry.profileLabel);
    return [...seen].sort((a, b) => a[1].localeCompare(b[1]));
  }, [sorted]);

  const searched = useMemo(
    () =>
      filterConnectionLogEntries(sorted, searchQuery).filter(
        (entry) => profileFilter === "all" || entry.profileId === profileFilter
      ),
    [sorted, searchQuery, profileFilter]
  );
  const statusCounts = useMemo(
    () => ({
      all: searched.length,
      open: filterSessionsByStatus(searched, "open").length,
      failed: filterSessionsByStatus(searched, "failed").length,
    }),
    [searched]
  );
  const rows = useMemo(
    () =>
      collapseRepeatedSessions(filterSessionsByStatus(searched, statusFilter)),
    [searched, statusFilter]
  );
  const showDevice = useMemo(() => hasSeveralDevices(sorted), [sorted]);

  const { visibleItems, sentinelRef, hasMore } = useInfiniteScroll(rows, {
    pageSize: LOG_PAGE_SIZE,
    resetKey: `${searchQuery}:${statusFilter}:${profileFilter}:${rows.length}`,
  });
  const days = useMemo(
    () => groupRowsByDay(visibleItems, now),
    [visibleItems, now]
  );

  const canOpen = (profileId: string) =>
    !!onOpenConnection && (knownProfileIds?.has(profileId) ?? true);
  const canShow = (profileId: string) =>
    !!onShowConnection && (knownProfileIds?.has(profileId) ?? true);

  async function handleClear() {
    const ok = await confirmDialog(
      "Clear the connection history on this device? Sessions that are still open stay.",
      {
        title: "Clear history",
        kind: "warning",
        okLabel: "Clear",
        cancelLabel: "Cancel",
      }
    );
    if (ok) clearLog();
  }

  const isFiltered =
    !!searchQuery.trim() || statusFilter !== "all" || profileFilter !== "all";
  const columnCount = showDevice ? 5 : 4;

  return (
    <div class="h-full w-full bg-slate-50">
      <div class="mx-auto w-full max-w-400 px-6 py-5">
        <div class="mb-3 flex items-center justify-between gap-4">
          <h2 class="flex items-center gap-2 text-sm font-semibold tracking-wide text-slate-800">
            <ClockIcon className="size-4 text-slate-500" />
            Last {MAX_ENTRIES} sessions ({sorted.length})
          </h2>
        </div>

        {sorted.length ? (
          <div class="mb-3 flex items-center justify-between gap-2">
            <div class="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Filter by status"
                class="flex overflow-hidden rounded-lg border border-slate-300 bg-white text-xs font-medium"
              >
                {STATUS_FILTERS.map((filter) => (
                  <button
                    key={filter.id}
                    type="button"
                    aria-pressed={statusFilter === filter.id}
                    class={cn(
                      "px-3 py-1.5 transition-colors",
                      statusFilter === filter.id
                        ? "bg-blue-50 text-blue-700 dark:bg-blue-950/50 dark:text-blue-300"
                        : "text-slate-600 hover:bg-slate-50"
                    )}
                    onClick={() => setStatusFilter(filter.id)}
                  >
                    {filter.label} ({statusCounts[filter.id]})
                  </button>
                ))}
              </div>
              <select
                aria-label="Filter by connection"
                class="h-8 rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-700"
                value={profileFilter}
                onInput={(e) => setProfileFilter(e.currentTarget.value)}
              >
                <option value="all">All connections</option>
                {connections.map(([id, label]) => (
                  <option key={id} value={id}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            {sorted.length ? (
              <Button
                variant="outline"
                className="h-8 gap-1.5 border-rose-300 px-2.5 text-xs text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                onClick={() => void handleClear()}
              >
                <TrashIcon className="size-3.5" />
                Clear history
              </Button>
            ) : null}
          </div>
        ) : null}

        <div class="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
          {rows.length === 0 ? (
            <div class="px-6 py-14 text-center">
              <ClockIcon className="mx-auto mb-3 size-10 text-slate-400" />
              <p class="text-sm font-medium text-slate-800">
                {isFiltered
                  ? "No matching sessions"
                  : "No connection history yet"}
              </p>
              <p class="mt-1 text-sm text-slate-500">
                {isFiltered
                  ? "Try another search term or filter."
                  : "Open a saved connection to record a session here."}
              </p>
            </div>
          ) : (
            <OverlayScrollArea horizontal vertical={false}>
              <table class="w-full min-w-180 table-fixed border-collapse text-left text-sm">
                <thead>
                  <tr class="border-b border-slate-200 bg-slate-50/80 text-xs font-semibold tracking-wide text-slate-500 uppercase">
                    <th class="p-2.5 pl-4">Connection</th>
                    <th class="w-32 p-2.5">Status</th>
                    <th class="w-42 p-2.5 whitespace-nowrap">Time</th>
                    {showDevice ? (
                      <th class="w-40 p-2.5 whitespace-nowrap">Device</th>
                    ) : null}
                    <th class="w-28 p-2.5">
                      <span class="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                {days.map((day) => (
                  <tbody key={day.key}>
                    <tr class="bg-slate-50/60 dark:bg-white/5">
                      <th
                        colSpan={columnCount}
                        scope="colgroup"
                        class="px-4 py-1.5 text-xs font-semibold text-slate-500 dark:text-slate-400"
                      >
                        {day.label}
                      </th>
                    </tr>
                    {day.rows.map((row) => (
                      <SessionRow
                        key={row.entry.id}
                        row={row}
                        now={now}
                        showDevice={showDevice}
                        canOpen={canOpen(row.entry.profileId)}
                        canShow={canShow(row.entry.profileId)}
                        onOpen={() => onOpenConnection?.(row.entry.profileId)}
                        onShow={() => onShowConnection?.(row.entry.profileId)}
                      />
                    ))}
                  </tbody>
                ))}
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

function SessionRow(props: {
  row: ConnectionLogRow;
  now: number;
  showDevice: boolean;
  canOpen: boolean;
  canShow: boolean;
  onOpen: () => void;
  onShow: () => void;
}) {
  const { row, now, showDevice, canOpen, canShow, onOpen, onShow } = props;
  const { entry, count } = row;
  const status = connectionLogDisplayStatus(entry.status);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const { address, database } = splitSessionTarget(entry.host);
  const target = [entry.dbUser ? `${entry.dbUser}@` : "", entry.host].join("");

  const menuItems: MenuItem[] = [
    {
      type: "item",
      label: "Open connection",
      icon: <PlayIcon className="size-4" />,
      disabled: !canOpen,
      onClick: onOpen,
    },
    {
      type: "item",
      label: "Show in connections",
      icon: <DatabaseIcon className="size-4" />,
      disabled: !canShow,
      onClick: onShow,
    },
    ...(entry.error
      ? ([
          { type: "sep" },
          {
            type: "item",
            label: "Copy error message",
            icon: <CopyIcon className="size-4" />,
            onClick: () => void navigator.clipboard.writeText(entry.error!),
          },
        ] as MenuItem[])
      : []),
  ];

  return (
    <>
      <tr
        tabIndex={0}
        class="group border-b border-slate-100 transition-colors outline-none hover:bg-slate-50/80 focus-visible:bg-blue-50/60 dark:focus-visible:bg-blue-950/40"
        title={canOpen ? "Double-click to open this connection" : undefined}
        // Only the row itself: a double-click or Enter on its buttons (Retry,
        // the menu) does their own thing.
        onDblClick={(e) => {
          if (isFromControl(e)) return;
          if (canOpen) onOpen();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canOpen && e.target === e.currentTarget) {
            e.preventDefault();
            onOpen();
          }
          if ((e.shiftKey && e.key === "F10") || e.key === "ContextMenu") {
            e.preventDefault();
            const rect = menuButtonRef.current?.getBoundingClientRect();
            if (rect) setMenu({ x: rect.left - 150, y: rect.bottom + 6 });
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <td class="py-1.5 pr-2.5 pl-4 align-middle">
          <div class="flex min-w-0 items-center gap-2.5">
            <DbIcon engine={entry.engine} className="size-6! shrink-0" />
            <div class="min-w-0">
              <div class="flex min-w-0 items-center gap-1.5">
                <span class="truncate font-medium text-slate-900">
                  {entry.profileLabel}
                </span>
                {count > 1 ? (
                  <span
                    class="shrink-0 rounded-md bg-slate-100 px-1.5 text-[11px] font-semibold text-slate-600"
                    title={`${count} sessions in a row`}
                  >
                    ×{count}
                  </span>
                ) : null}
              </div>
              <div class="flex min-w-0 text-xs text-slate-500" title={target}>
                <span class="truncate">
                  {truncateMiddle(address, MAX_ADDRESS)}
                </span>
                {database ? (
                  <span class="shrink-0 whitespace-pre"> • {database}</span>
                ) : null}
              </div>
              {entry.error ? (
                <div
                  class="max-w-160 truncate text-xs text-red-700 dark:text-red-300"
                  title={entry.error}
                >
                  {entry.error}
                </div>
              ) : null}
            </div>
          </div>
        </td>
        <td class="p-2.5 align-middle">
          <StatusBadge status={status} />
        </td>
        <td class="p-2.5 align-middle whitespace-nowrap text-slate-700 tabular-nums">
          <span class="font-medium text-slate-900">
            {formatSessionTime(entry.openedAt)}
          </span>
          <span class="text-slate-500">
            {" · "}
            {status === "open" ? "open " : ""}
            {formatSessionDuration(entry.openedAt, entry.closedAt, now)}
          </span>
        </td>
        {showDevice ? (
          <td class="p-2.5 align-middle whitespace-nowrap text-slate-700">
            {entry.deviceName}
          </td>
        ) : null}
        <td class="p-2.5 pr-3 align-middle">
          <div class="flex items-center justify-end gap-1">
            {status === "failed" && canOpen ? (
              <Button
                variant="outline"
                className="h-7 px-2 text-xs"
                onClick={(e) => {
                  e.stopPropagation();
                  // The second click of a double-click must not retry again.
                  if (e.detail > 1) return;
                  onOpen();
                }}
              >
                Retry
              </Button>
            ) : null}
            <KebabButton
              menuOpen={menu !== null}
              buttonRef={menuButtonRef}
              onClick={() => {
                const rect = menuButtonRef.current?.getBoundingClientRect();
                if (rect) setMenu({ x: rect.left - 150, y: rect.bottom + 6 });
              }}
            />
          </div>
        </td>
      </tr>
      <ContextMenu
        open={menu !== null}
        x={menu?.x ?? 0}
        y={menu?.y ?? 0}
        items={menuItems}
        onClose={() => setMenu(null)}
      />
    </>
  );
}

/** Whether an event started on a button or link inside the row. */
function isFromControl(e: Event) {
  const target = e.target as HTMLElement | null;
  return !!target?.closest("button, a, input, select");
}

function StatusBadge(props: {
  status: ReturnType<typeof connectionLogDisplayStatus>;
}) {
  const { status } = props;
  if (status === "open") {
    return (
      <span class="inline-flex items-center gap-1.5 rounded-md bg-blue-50 px-2 py-0.5 text-xs font-semibold text-blue-700 dark:text-blue-300">
        <span class="size-1.5 animate-pulse rounded-full bg-blue-500" />
        Open
      </span>
    );
  }
  return (
    <span
      class={cn(
        "inline-flex rounded-md px-2 py-0.5 text-xs font-semibold",
        status === "failed"
          ? "bg-red-50 text-red-700"
          : "bg-emerald-50 text-emerald-700"
      )}
    >
      {status === "failed" ? "Failed" : "Success"}
    </span>
  );
}
