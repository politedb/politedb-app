import { Spinner } from "src/components/common/Spinner";
import { Button } from "src/components/common/Button";
import { Tooltip } from "src/components/common/Tooltip";
import { formatBytesSize } from "src/utils/convert";
import {
  formatClientBackendCount,
  formatExactCount,
  formatHealthInspectorTimestamp,
  formatServerConnectionUsage,
} from "src/lib/healthInspector/format";
import {
  BLOCKING_LIMITATION_NOTE,
  CONNECTIONS_TOOLTIP,
  DEADLOCKS_CAVEAT,
  TEMP_FILES_CAVEAT,
  buildAttentionItems,
  clientBackendClassificationIncomplete,
  formatAgeSeconds,
  formatOptionalNumber,
  overviewVisibilityNote,
} from "src/lib/healthInspector/signals";
import type {
  HealthInspectorSnapshot,
  HealthSection,
} from "src/lib/healthInspector/types";

function formatCollectedAt(ts: number | null): string {
  return formatHealthInspectorTimestamp(ts);
}

function SectionBanner(props: {
  section: HealthSection<unknown>;
  loading: boolean;
}) {
  const { section, loading } = props;
  if (loading && section.status === "loading") {
    return (
      <div class="flex items-center gap-2 text-sm text-neutral-600">
        <Spinner className="size-4" />
        Loading…
      </div>
    );
  }
  if (section.status === "unavailable") {
    return (
      <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50">
        Unavailable
        {section.unavailableReason ? `: ${section.unavailableReason}` : ""}
      </div>
    );
  }
  if (section.status === "error") {
    return (
      <div class="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-50">
        Error{section.error ? `: ${section.error}` : ""}
        <span class="ml-2 text-xs text-red-600 dark:text-red-200">
          Collected {formatCollectedAt(section.collectedAt)}
        </span>
      </div>
    );
  }
  return null;
}

function MetricCard(props: {
  label: string;
  value: string;
  detail?: string | null;
  title?: string;
}) {
  const card = (
    <div class="rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900/40">
      <div class="text-sm font-medium text-neutral-500 dark:text-neutral-400">
        {props.label}
      </div>
      <div class="mt-0.5 text-base font-semibold text-neutral-900 dark:text-neutral-50">
        {props.value}
      </div>
      {props.detail ? (
        <div class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {props.detail}
        </div>
      ) : null}
    </div>
  );
  if (!props.title) return card;
  return (
    <Tooltip content={props.title} width={360}>
      {card}
    </Tooltip>
  );
}

export function DbHealthInspectorOverview(props: {
  snap: HealthInspectorSnapshot | null;
  loading: boolean;
  onOpenSessions: () => void;
}) {
  const section = props.snap?.overview;
  if (!section) {
    return props.loading ? (
      <div class="flex items-center gap-2 text-sm text-neutral-600">
        <Spinner className="size-4 text-neutral-500" />
        Loading…
      </div>
    ) : (
      <div class="text-sm text-neutral-500">No overview yet.</div>
    );
  }

  const data = section.data;
  const note = overviewVisibilityNote(data);
  const attention = buildAttentionItems(data ?? null);
  const statsResetLabel = data?.statsReset
    ? formatHealthInspectorTimestamp(data.statsReset)
    : null;

  const cards = data
    ? [
        {
          label: "Sessions",
          value: formatOptionalNumber(data.sessionCount),
          detail: "Current database (all backends with this datname)",
        },
        {
          label: "Active",
          value: formatOptionalNumber(data.activeSessionCount),
          detail: "Excludes this Inspector connection",
        },
        {
          label: "Idle",
          value: formatOptionalNumber(data.idleSessionCount),
          detail: "Excludes this Inspector connection",
        },
        {
          label: "Idle in transaction",
          value: formatOptionalNumber(data.idleInTransactionCount),
          detail:
            data.idleInTransactionCount == null
              ? data.restrictedVisibility
                ? "Unknown (restricted visibility)"
                : null
              : `Oldest txn ${formatAgeSeconds(data.idleInTransactionOldestXactAgeSeconds)} · longest idle ${formatAgeSeconds(data.idleInTransactionLongestIdleSeconds)}`,
        },
        {
          label: "Blocked",
          value: formatOptionalNumber(data.blockedSessionCount),
          detail:
            data.topBlockers.length > 0
              ? `Top blockers: ${data.topBlockers
                  .map((b) =>
                    b.isPreparedTransaction
                      ? "prepared xact (0)"
                      : String(b.pid)
                  )
                  .join(", ")}`
              : data.lockWaitDurationAvailable
                ? null
                : "Lock-wait duration unavailable",
        },
        {
          label: "Longest txn",
          value: formatAgeSeconds(data.longestXactAgeSeconds),
          detail: "Excludes this Inspector connection",
        },
        {
          label: "DB clients",
          value: formatClientBackendCount(
            data.clientBackendCountDatabase,
            data.hiddenBackendTypeCountDatabase
          ),
          detail:
            (data.hiddenBackendTypeCountDatabase ?? 0) > 0
              ? "Visible client backends only — some sessions hide backend_type"
              : "Client backends in this database (includes this app)",
          title: CONNECTIONS_TOOLTIP,
        },
        {
          label: "Server clients",
          value: formatServerConnectionUsage(
            data.clientBackendCountServer,
            data.maxConnections,
            data.hiddenBackendTypeCountServer
          ),
          detail:
            (data.hiddenBackendTypeCountServer ?? 0) > 0
              ? "Visible-only lower bound vs configured maximum — not a complete total"
              : "Approximate vs configured maximum — not available slots",
          title: CONNECTIONS_TOOLTIP,
        },
        {
          label: "Database size",
          value:
            data.databaseBytes == null
              ? "—"
              : formatBytesSize(data.databaseBytes, { fractionDigits: 1 }),
        },
        {
          label: "Temp files",
          value: formatExactCount(data.tempFiles),
          detail:
            data.tempBytes == null
              ? TEMP_FILES_CAVEAT
              : `${formatBytesSize(data.tempBytes, { fractionDigits: 1 })} cumulative · ${TEMP_FILES_CAVEAT}`,
        },
        {
          label: "Deadlocks",
          value: formatExactCount(data.deadlocks),
          detail: DEADLOCKS_CAVEAT,
        },
      ]
    : [];

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <SectionBanner section={section} loading={props.loading} />
      <div class="text-xs text-neutral-500 dark:text-neutral-400">
        {statsResetLabel
          ? `Stats reset: ${statsResetLabel} (observation window for cumulative counters; Refresh does not reset statistics)`
          : "Stats reset time unavailable — observation window for cumulative counters is unknown"}
      </div>
      {section.status === "ready" && data ? (
        <>
          <div class="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {cards.map((c) => (
              <MetricCard
                key={c.label}
                label={c.label}
                value={c.value}
                detail={c.detail}
                title={"title" in c ? c.title : undefined}
              />
            ))}
          </div>

          {data.topBlockers.length > 0 ||
          (data.blockedSessionCount != null && data.blockedSessionCount > 0) ? (
            <div class="text-xs text-neutral-500 dark:text-neutral-400">
              {BLOCKING_LIMITATION_NOTE}
              {data.hasUnresolvedBlockers
                ? " Some listed blocker PIDs are unresolved."
                : ""}
              <Button
                type="button"
                variant="ghost"
                className="ml-2 h-7 px-2 text-xs"
                onClick={props.onOpenSessions}
              >
                Open Sessions
              </Button>
            </div>
          ) : null}

          {note ? (
            <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50">
              {note}
            </div>
          ) : null}

          <div class="mt-1">
            <div class="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              Attention
            </div>
            {attention.length === 0 ? (
              <p class="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
                {data.restrictedVisibility ||
                clientBackendClassificationIncomplete(data)
                  ? "Visibility is incomplete — not reporting healthy."
                  : "No actionable current conditions in this snapshot."}
              </p>
            ) : (
              <ul class="mt-1 space-y-2 text-sm">
                {attention.map((item) => (
                  <li
                    key={`${item.kind}-${item.title}`}
                    class="flex flex-col gap-1 border-b border-neutral-100 py-2 last:border-b-0 dark:border-neutral-800"
                  >
                    <div class="flex flex-wrap items-center gap-2">
                      <span
                        class={
                          item.tone === "actionable"
                            ? "font-medium text-amber-800 dark:text-amber-200"
                            : item.tone === "incomplete"
                              ? "font-medium text-amber-800 dark:text-amber-200"
                              : "font-medium text-neutral-700 dark:text-neutral-200"
                        }
                      >
                        {item.title}
                      </span>
                      {item.tone === "informational" ? (
                        <span class="rounded bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                          history
                        </span>
                      ) : null}
                      {item.openSessions ? (
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={props.onOpenSessions}
                        >
                          Open Sessions
                        </Button>
                      ) : null}
                    </div>
                    <p class="text-xs text-neutral-500 dark:text-neutral-400">
                      {item.evidence}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
