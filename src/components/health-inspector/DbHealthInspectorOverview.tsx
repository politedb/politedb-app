import { Skeleton } from "src/components/common/Skeleton";
import { Button } from "src/components/common/Button";
import { cn } from "src/utils/cn";
import {
  formatExactCount,
  formatHealthInspectorTimestamp,
  formatInspectorBytes,
} from "src/lib/health-inspector/format";
import {
  BLOCKING_LIMITATION_NOTE,
  DEADLOCKS_CAVEAT,
  LONGEST_TRANSACTION_NOTE,
  SESSIONS_SCOPE_NOTE,
  STATS_RESET_NOTE,
  TEMP_FILES_CAVEAT,
  buildAttentionItems,
  formatAgeSeconds,
  formatLongestTransaction,
  formatOptionalNumber,
  overviewMetricTones,
  splitAttentionItems,
  type HealthMetricTone,
} from "src/lib/health-inspector/signals";
import type {
  HealthAttentionItem,
  HealthInspectorSnapshot,
  HealthOverview,
  HealthSection,
} from "src/lib/health-inspector/types";
import { InfoHint } from "./InfoHint";

function formatCollectedAt(ts: number | null): string {
  return formatHealthInspectorTimestamp(ts);
}

function SectionBanner(props: {
  section: HealthSection<unknown>;
  loading: boolean;
}) {
  const { section, loading } = props;
  if (loading && section.status === "loading") {
    return null;
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

const CARD_TONE_CLASS: Record<HealthMetricTone, string> = {
  critical: "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/60",
  warning:
    "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/60",
  ok: "border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900/40",
  neutral:
    "border-neutral-200 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900/40",
};

const VALUE_TONE_CLASS: Record<HealthMetricTone, string> = {
  critical: "text-red-700 dark:text-red-200",
  warning: "text-amber-800 dark:text-amber-200",
  ok: "text-neutral-900 dark:text-neutral-50",
  neutral: "text-neutral-900 dark:text-neutral-50",
};

const DOT_TONE_CLASS: Record<HealthMetricTone, string | null> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  ok: "bg-emerald-500",
  neutral: null,
};

type OverviewCard = {
  label: string;
  value: string;
  detail?: string | null;
  hint?: string;
  tone?: HealthMetricTone;
  wide?: boolean;
};

function MetricCard(props: OverviewCard) {
  const tone = props.tone ?? "neutral";
  const dot = DOT_TONE_CLASS[tone];
  return (
    <div
      class={cn(
        "h-full rounded-lg border px-3 py-2",
        CARD_TONE_CLASS[tone],
        props.wide && "col-span-2"
      )}
      data-tone={tone}
    >
      <div class="flex items-center gap-1.5 text-sm font-medium text-neutral-500 dark:text-neutral-400">
        {dot ? (
          <span class={cn("size-1.5 rounded-full", dot)} aria-hidden="true" />
        ) : null}
        {props.label}
        {props.hint ? <InfoHint text={props.hint} /> : null}
      </div>
      <div class={cn("mt-0.5 text-base font-semibold", VALUE_TONE_CLASS[tone])}>
        {props.value}
      </div>
      {props.detail ? (
        <div class="mt-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          {props.detail}
        </div>
      ) : null}
    </div>
  );
}

function AttentionSummary(props: {
  items: HealthAttentionItem[];
  onOpenSessions: () => void;
}) {
  const { issues, history } = splitAttentionItems(props.items);
  const critical = issues.some((i) => i.kind === "blocked");
  return (
    <section
      aria-label="Attention"
      class={cn(
        "rounded-lg border px-3 py-2",
        issues.length === 0
          ? "border-emerald-200 bg-emerald-50 dark:border-emerald-800 dark:bg-emerald-950/50"
          : critical
            ? "border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/60"
            : "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/60"
      )}
    >
      <div
        class={cn(
          "text-sm font-semibold",
          issues.length === 0
            ? "text-emerald-800 dark:text-emerald-200"
            : critical
              ? "text-red-800 dark:text-red-200"
              : "text-amber-900 dark:text-amber-100"
        )}
      >
        {issues.length === 0
          ? "✓ All clear in this snapshot"
          : `⚠ ${issues.length} issue${issues.length === 1 ? "" : "s"}`}
      </div>
      {issues.length > 0 ? (
        <ul class="mt-1 space-y-0.5 text-sm">
          {issues.map((item) => (
            <li
              key={`${item.kind}-${item.title}`}
              class="flex flex-wrap items-center gap-x-2 gap-y-0.5"
            >
              <span class="text-neutral-800 dark:text-neutral-100">
                {item.title}
              </span>
              <InfoHint text={item.evidence} />
              {item.openSessions ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="h-6 px-1.5 text-xs font-medium text-neutral-800 underline-offset-2 hover:underline dark:text-neutral-100"
                  onClick={props.onOpenSessions}
                >
                  Open Sessions
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {history.map((item) => (
        <div
          key={`${item.kind}-${item.title}`}
          class="mt-1 flex items-center gap-1.5 text-xs text-neutral-600 dark:text-neutral-300"
        >
          <span class="rounded bg-white/70 px-1.5 py-0.5 dark:bg-neutral-800">
            history
          </span>
          {item.title}
          <InfoHint text={item.evidence} />
        </div>
      ))}
    </section>
  );
}

const OVERVIEW_SKELETON_CARD_COUNT = 8;

function OverviewSkeleton() {
  return (
    <div
      class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto"
      role="status"
      aria-label="Loading overview"
    >
      <Skeleton className="h-12 w-full rounded-lg" />
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {Array.from({ length: OVERVIEW_SKELETON_CARD_COUNT }, (_, i) => (
          <div
            key={i}
            class="h-full rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 dark:border-neutral-700 dark:bg-neutral-900/40"
          >
            <Skeleton className="h-3.5 w-20" />
            <Skeleton className="mt-2 h-5 w-16" />
            <Skeleton className="mt-1.5 h-3 w-full" />
          </div>
        ))}
      </div>
      <Skeleton className="h-3 w-48 max-w-full" />
    </div>
  );
}

function overviewCards(data: HealthOverview): OverviewCard[] {
  const tones = overviewMetricTones(data);
  const idleInXact = data.idleInTransactionCount;
  const blockers = data.topBlockers
    .map((b) => (b.isPreparedTransaction ? "prepared xact (0)" : String(b.pid)))
    .join(", ");
  return [
    {
      label: "Sessions",
      value:
        data.sessionCount == null
          ? "—"
          : `${formatOptionalNumber(data.sessionCount)} session${data.sessionCount === 1 ? "" : "s"}`,
      detail: `${formatOptionalNumber(data.idleSessionCount)} idle · ${formatOptionalNumber(data.activeSessionCount)} active`,
      hint: SESSIONS_SCOPE_NOTE,
      wide: true,
    },
    {
      label: "Blocked",
      value: formatOptionalNumber(data.blockedSessionCount),
      detail: blockers ? `Top blockers: ${blockers}` : null,
      hint: BLOCKING_LIMITATION_NOTE,
      tone: tones.blocked,
    },
    {
      label: "Idle in transaction",
      value: formatOptionalNumber(idleInXact),
      detail:
        idleInXact == null
          ? data.restrictedVisibility
            ? "Unknown (restricted visibility)"
            : null
          : idleInXact > 0
            ? `Oldest txn ${formatAgeSeconds(data.idleInTransactionOldestXactAgeSeconds)} · longest idle ${formatAgeSeconds(data.idleInTransactionLongestIdleSeconds)}`
            : null,
      tone: tones.idleInTransaction,
    },
    {
      label: "Longest txn",
      value: formatLongestTransaction(data),
      hint: LONGEST_TRANSACTION_NOTE,
      tone: tones.longestTransaction,
    },
    {
      label: "Database size",
      value: formatInspectorBytes(data.databaseBytes),
    },
    {
      label: "Temp files",
      value: data.tempFiles === 0 ? "None" : formatExactCount(data.tempFiles),
      detail:
        data.tempBytes == null || data.tempBytes === 0
          ? null
          : `${formatInspectorBytes(data.tempBytes)} total`,
      hint: TEMP_FILES_CAVEAT,
    },
    {
      label: "Deadlocks",
      value: data.deadlocks === 0 ? "None" : formatExactCount(data.deadlocks),
      hint: DEADLOCKS_CAVEAT,
    },
  ];
}

export function DbHealthInspectorOverview(props: {
  snap: HealthInspectorSnapshot | null;
  loading: boolean;
  onOpenSessions: () => void;
}) {
  const section = props.snap?.overview;
  // The overview is collected first; once in, it shows while the other
  // sections are still being collected.
  if (props.loading && (!section || section.status === "loading")) {
    return <OverviewSkeleton />;
  }
  if (!section) {
    return <div class="text-sm text-neutral-500">No overview yet.</div>;
  }

  const data = section.data;
  const attention = buildAttentionItems(data ?? null);
  const statsResetLabel = data?.statsReset
    ? formatHealthInspectorTimestamp(data.statsReset)
    : null;

  const cards: OverviewCard[] = data ? overviewCards(data) : [];
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto">
      <SectionBanner section={section} loading={props.loading} />
      {section.status === "ready" && data ? (
        <>
          <AttentionSummary
            items={attention}
            onOpenSessions={props.onOpenSessions}
          />

          <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {cards.map((c) => (
              <MetricCard key={c.label} {...c} />
            ))}
          </div>

          <div class="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500">
            {statsResetLabel
              ? `Counters since ${statsResetLabel}`
              : "Counter start unknown (stats reset time unavailable)"}
            <InfoHint text={STATS_RESET_NOTE} />
          </div>
        </>
      ) : null}
    </div>
  );
}
