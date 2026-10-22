import { useEffect, useMemo, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Tabs } from "src/components/common/Tabs";
import { Table, type TableColumn } from "src/components/common/Table";
import { Skeleton } from "src/components/common/Skeleton";
import {
  CopyCheckIcon,
  CopyIcon,
  DbInspectorIcon,
  RefreshCwIcon,
  StopIcon,
} from "src/components/icons";
import { useDbHealthInspector } from "@root/src/hooks/useDbHealthInspector";
import { HEALTH_INSPECTOR_AUTO_REFRESH_OPTIONS } from "src/lib/health-inspector/autoRefresh";
import { useProGate } from "src/hooks/useProGate";
import { ProBadge } from "src/components/license/ProBadge";
import type { DatabaseEngine } from "src/types";
import {
  formatCollectionDuration,
  formatHealthInspectorTimestamp,
  formatInspectorBytes,
  formatSnapshotTime,
  latestHealthTimestamp,
} from "src/lib/health-inspector/format";
import {
  DEAD_ROW_CAVEAT,
  INDEX_SCAN_CAVEAT,
  PARTITION_SIZE_NOTE,
  SIZE_RANKING_NOTE,
  deadRowRatio,
  formatAgeSeconds,
  formatOptionalNumber,
  formatPercent,
  isUnusedIndex,
  matchesHealthFilter,
  needsVacuum,
} from "src/lib/health-inspector/signals";
import {
  healthInspectorDropIndexSql,
  healthInspectorVacuumSql,
} from "src/lib/queries/sql/health-inspector";
import type {
  HealthIndexRow,
  HealthInspectorSnapshot,
  HealthSection,
  HealthSessionRow,
  HealthStatementRow,
  HealthTableRow,
} from "src/lib/health-inspector/types";
import { DbHealthInspectorOverview } from "./DbHealthInspectorOverview";
import {
  CopySqlButton,
  EMPTY_SECTION_FILTER,
  SectionToolbar,
  type SectionFilterState,
} from "./SectionToolbar";
import { cn } from "src/utils/cn";

type SectionKey = "overview" | "sessions" | "statements" | "tables" | "indexes";
type ListKey = Exclude<SectionKey, "overview">;

const INITIAL_FILTERS: Record<ListKey, SectionFilterState> = {
  sessions: EMPTY_SECTION_FILTER,
  statements: EMPTY_SECTION_FILTER,
  tables: EMPTY_SECTION_FILTER,
  indexes: EMPTY_SECTION_FILTER,
};

type Props = {
  open: boolean;
  onClose: () => void;
  runtimeConnectionId?: string;
  profileId?: string | null;
  engine?: DatabaseEngine;
  databaseLabel?: string;
};

function formatCollectedAt(ts: number | null): string {
  return formatHealthInspectorTimestamp(ts);
}

const PG_STAT_STATEMENTS_EXTENSION_SQL =
  "CREATE EXTENSION IF NOT EXISTS pg_stat_statements;";
const PG_STAT_STATEMENTS_PRELOAD_VALUE = "pg_stat_statements";
const PG_STAT_STATEMENTS_PRELOAD_CONFIG =
  "shared_preload_libraries = 'pg_stat_statements'";

function isMissingPgStatStatementsExtension(reason: string | null): boolean {
  const normalized = reason?.toLowerCase() ?? "";
  return (
    normalized.includes("extension") && normalized.includes("not installed")
  );
}

function isPgStatStatementsPreloadRequired(reason: string | null): boolean {
  const normalized = reason?.toLowerCase() ?? "";
  return normalized.includes("shared_preload_libraries");
}

function CopyTextButton(props: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1000);
    } catch {
      // Clipboard access can be unavailable in restricted contexts.
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      className="h-7 w-7 shrink-0 p-0 text-neutral-600 hover:text-neutral-900 dark:text-blue-200 dark:hover:text-white"
      onClick={() => void handleCopy()}
      title={copied ? "Copied!" : props.label}
      aria-label={copied ? "Copied" : props.label}
    >
      {copied ? (
        <CopyCheckIcon className="size-3.5 text-green-700 dark:text-green-300" />
      ) : (
        <CopyIcon className="size-3.5" />
      )}
    </Button>
  );
}

function PgStatStatementsInstallGuide() {
  return (
    <div class="rounded-md border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-950 dark:border-blue-500/40 dark:bg-blue-950/40 dark:text-blue-100">
      <div class="font-medium">Enable Top statements</div>
      <p class="mt-1">
        Run these steps in your SQL window, admin tool, or cloud console.
        PoliteDB is read-only and will not execute them.
      </p>
      <ol class="mt-2 list-decimal space-y-2 pl-5">
        <li>
          <div class="flex items-center justify-between gap-2">
            <span>On the current database, create the extension:</span>
          </div>
          <code class="relative mt-1 block w-fit rounded border border-blue-200/80 bg-white/80 p-2 pr-8 font-mono text-xs text-blue-950 dark:border-blue-400/40 dark:bg-slate-950/70 dark:text-slate-100">
            {PG_STAT_STATEMENTS_EXTENSION_SQL}
            <div class="absolute top-0.5 right-0.5">
              <CopyTextButton
                value={PG_STAT_STATEMENTS_EXTENSION_SQL}
                label="Copy extension SQL"
              />
            </div>
          </code>
        </li>
        <li>
          If needed, add{" "}
          <code class="rounded border border-blue-200/80 bg-white/80 px-1 py-0.5 font-mono text-xs text-blue-950 dark:border-blue-400/40 dark:bg-slate-950/70 dark:text-slate-100">
            {PG_STAT_STATEMENTS_PRELOAD_VALUE}
          </code>{" "}
          to <code>shared_preload_libraries</code>, restart Postgres, then run
          Step 1 again.
        </li>
      </ol>
    </div>
  );
}

function PgStatStatementsPreloadGuide() {
  return (
    <div class="rounded-md border border-blue-200 bg-blue-50 px-3 py-3 text-sm text-blue-950 dark:border-blue-500/40 dark:bg-blue-950/40 dark:text-blue-100">
      <div class="font-medium">Load pg_stat_statements</div>
      <p class="mt-1">
        pg_stat_statements must be loaded via shared_preload_libraries before
        Top statements can work. PoliteDB is read-only and will not change
        server config.
      </p>
      <ol class="mt-2 list-decimal space-y-2 pl-5">
        <li>
          <div>
            Add{" "}
            <code class="rounded border border-blue-200/80 bg-white/80 px-1 py-0.5 font-mono text-xs text-blue-950 dark:border-blue-400/40 dark:bg-slate-950/70 dark:text-slate-100">
              {PG_STAT_STATEMENTS_PRELOAD_VALUE}
            </code>{" "}
            to <code>shared_preload_libraries</code> in{" "}
            <code>postgresql.conf</code> (or your cloud provider's equivalent).
            Merge with any existing libraries rather than replacing them:
          </div>
          <code class="relative mt-1 block w-fit rounded border border-blue-200/80 bg-white/80 p-2 pr-8 font-mono text-xs text-blue-950 dark:border-blue-400/40 dark:bg-slate-950/70 dark:text-slate-100">
            {PG_STAT_STATEMENTS_PRELOAD_CONFIG}
            <div class="absolute top-0.5 right-0.5">
              <CopyTextButton
                value={PG_STAT_STATEMENTS_PRELOAD_CONFIG}
                label="Copy preload config"
              />
            </div>
          </code>
        </li>
        <li>Restart Postgres so the preload change takes effect.</li>
        <li>Return here and click Refresh in Health Inspector.</li>
      </ol>
      <p class="mt-2 text-xs opacity-90">
        If create extension also fails after restart, run:
      </p>
      <code class="relative mt-1 block w-fit rounded border border-blue-200/80 bg-white/80 p-2 pr-8 font-mono text-xs text-blue-950 dark:border-blue-400/40 dark:bg-slate-950/70 dark:text-slate-100">
        {PG_STAT_STATEMENTS_EXTENSION_SQL}
        <div class="absolute top-0.5 right-0.5">
          <CopyTextButton
            value={PG_STAT_STATEMENTS_EXTENSION_SQL}
            label="Copy extension SQL"
          />
        </div>
      </code>
    </div>
  );
}

function SectionBanner(props: {
  section: HealthSection<unknown>;
  loading: boolean;
  caveat?: string;
  /** Shown prominently: the size order is an estimate on this database. */
  rankingNote?: string | null;
  showPgStatStatementsGuide?: boolean;
}) {
  const { section, loading, caveat, rankingNote, showPgStatStatementsGuide } =
    props;
  if (loading && section.status === "loading") {
    return null;
  }
  if (section.status === "unavailable") {
    const showInstallGuide =
      showPgStatStatementsGuide &&
      isMissingPgStatStatementsExtension(section.unavailableReason);
    const showPreloadGuide =
      showPgStatStatementsGuide &&
      !showInstallGuide &&
      isPgStatStatementsPreloadRequired(section.unavailableReason);
    return (
      <>
        <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50">
          <div>
            Unavailable
            {section.unavailableReason ? `: ${section.unavailableReason}` : ""}
          </div>
        </div>
        {showInstallGuide ? <PgStatStatementsInstallGuide /> : null}
        {showPreloadGuide ? <PgStatStatementsPreloadGuide /> : null}
      </>
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
  if (section.status === "empty") {
    return (
      <div class="text-sm text-neutral-500">
        No rows.
        <span class="ml-2 text-xs">
          Collected {formatCollectedAt(section.collectedAt)}
        </span>
      </div>
    );
  }
  return section.truncated || caveat || rankingNote ? (
    <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
      {rankingNote ? (
        <span class="rounded bg-amber-50 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950 dark:text-amber-100">
          {rankingNote}
        </span>
      ) : null}
      {section.truncated ? (
        <span class="rounded bg-neutral-100 px-1.5 py-0.5 text-neutral-700">
          Showing first 100 rows
        </span>
      ) : null}
      {caveat ? <span class="text-neutral-500">{caveat}</span> : null}
    </div>
  ) : null;
}

function QueryCell(props: { queryText: string | null; queryHidden: boolean }) {
  const [copied, setCopied] = useState(false);
  const canCopy = !props.queryHidden && !!props.queryText;

  const handleCopy = async (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!canCopy || props.queryText == null) return;

    try {
      await navigator.clipboard.writeText(props.queryText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1000);
    } catch {
      // Clipboard access can be unavailable in restricted contexts.
    }
  };

  return (
    <div class="flex min-w-0 items-center gap-1">
      <span class="min-w-0 flex-1 truncate">
        {props.queryHidden ? "(hidden)" : props.queryText || "—"}
      </span>
      {canCopy ? (
        <Button
          type="button"
          variant="ghost"
          className="h-6 w-6 shrink-0 p-0 text-neutral-500 hover:text-neutral-700"
          onClick={(event) => void handleCopy(event)}
          title={copied ? "Copied!" : "Copy query"}
          aria-label={copied ? "Copied" : "Copy query"}
        >
          {copied ? (
            <CopyCheckIcon className="size-3.5 text-green-700" />
          ) : (
            <CopyIcon className="size-3.5" />
          )}
        </Button>
      ) : null}
    </div>
  );
}

function TableSectionSkeleton(props: { columns?: number; rows?: number }) {
  const columns = props.columns ?? 5;
  const rows = props.rows ?? 8;
  return (
    <div
      class="flex min-h-0 flex-1 flex-col gap-2"
      role="status"
      aria-label="Loading table"
    >
      <Skeleton className="h-4 w-48 max-w-full" />
      <div class="min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-200 dark:border-neutral-700">
        <div class="border-b border-neutral-200 bg-neutral-50 px-2 py-2 dark:border-neutral-700 dark:bg-neutral-900/40">
          <div class="flex gap-3">
            {Array.from({ length: columns }, (_, i) => (
              <Skeleton key={i} className="h-3.5 flex-1" />
            ))}
          </div>
        </div>
        <div class="space-y-2 p-2">
          {Array.from({ length: rows }, (_, i) => (
            <div key={i} class="flex gap-3">
              {Array.from({ length: columns }, (_, j) => (
                <Skeleton key={j} className="h-4 flex-1" />
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

type SectionTableProps = {
  snap: HealthInspectorSnapshot | null;
  loading: boolean;
  filter: SectionFilterState;
  onFilterChange: (next: SectionFilterState) => void;
};

/**
 * Shared list layout: per-section skeleton, status banner, search/flag toolbar
 * and a sortable table over the filtered rows. Hooks run before any early
 * return so a section switching to loading never changes hook order.
 */
function ListSection<T>(props: {
  section: HealthSection<T[]> | undefined;
  loading: boolean;
  skeletonColumns: number;
  banner?: {
    caveat?: string;
    rankingNote?: string | null;
    showPgStatStatementsGuide?: boolean;
  };
  extra?: preact.ComponentChildren;
  filter: SectionFilterState;
  onFilterChange: (next: SectionFilterState) => void;
  placeholder: string;
  searchFields: (row: T) => Array<string | number | null | undefined>;
  flag?: { label: string; isFlagged: (row: T) => boolean };
  columns: TableColumn<T>[];
  keyExtractor: (row: T, index: number) => string | number;
  emptyMessage: string;
  rowClassName?: (row: T) => string;
}) {
  const { section, filter, flag, searchFields } = props;
  const rows = section?.data ?? EMPTY_ROWS;
  const flaggedCount = useMemo(
    () => (flag ? rows.filter(flag.isFlagged).length : 0),
    [rows, flag]
  );
  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          (!filter.flaggedOnly || !flag || flag.isFlagged(row)) &&
          matchesHealthFilter(searchFields(row), filter.query)
      ),
    [rows, filter, flag, searchFields]
  );

  if (!section || (props.loading && section.status === "loading")) {
    return props.loading ? (
      <TableSectionSkeleton columns={props.skeletonColumns} />
    ) : null;
  }
  const hasRows = section.status === "ready" || section.status === "empty";
  const filtered = visible.length !== rows.length;
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2">
      <SectionBanner
        section={section}
        loading={props.loading}
        caveat={props.banner?.caveat}
        rankingNote={props.banner?.rankingNote}
        showPgStatStatementsGuide={props.banner?.showPgStatStatementsGuide}
      />
      {props.extra}
      {hasRows && rows.length > 0 ? (
        <SectionToolbar
          filter={filter}
          onFilterChange={props.onFilterChange}
          placeholder={props.placeholder}
          shown={visible.length}
          total={rows.length}
          flag={flag ? { label: flag.label, count: flaggedCount } : undefined}
        />
      ) : null}
      {hasRows ? (
        <div class="min-h-0 overflow-hidden rounded-lg border border-neutral-200">
          <Table
            columns={props.columns}
            data={visible}
            keyExtractor={props.keyExtractor}
            emptyMessage={filtered ? "No matching rows" : props.emptyMessage}
            rowClassName={props.rowClassName}
            enableSort
          />
        </div>
      ) : null}
    </div>
  );
}

const EMPTY_ROWS: never[] = [];

function sessionNeedsAttention(row: HealthSessionRow): boolean {
  return (
    row.isBlocked ||
    (row.state != null && row.state.startsWith("idle in transaction"))
  );
}

const SESSION_FLAG = {
  label: "Blocked / idle in txn",
  isFlagged: sessionNeedsAttention,
};

const sessionSearchFields = (row: HealthSessionRow) => [
  row.pid,
  row.usename,
  row.applicationName,
  row.clientAddr,
  row.state,
  row.queryHidden ? null : row.queryText,
];

function SessionsTable(props: SectionTableProps) {
  const columns = useMemo<TableColumn<HealthSessionRow>[]>(
    () => [
      {
        key: "pid",
        label: "PID",
        sortable: true,
        sortKey: "pid",
        className: "text-sm p-2",
      },
      {
        key: "usename",
        label: "User · App",
        sortable: true,
        sortKey: "usename",
        className: "text-sm p-2 max-w-40",
        render: (_v, row) => (
          <div class="min-w-0">
            <div class="truncate">{row.usename ?? "—"}</div>
            {row.applicationName ? (
              <div class="truncate text-xs text-neutral-500">
                {row.applicationName}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        key: "state",
        label: "State",
        sortable: true,
        sortKey: "state",
        className: "text-sm p-2",
      },
      {
        key: "queryAgeSeconds",
        label: "Query age",
        sortable: true,
        sortKey: "queryAgeSeconds",
        className: "text-sm p-2",
        render: (_v, row) => formatAgeSeconds(row.queryAgeSeconds),
      },
      {
        key: "xactAgeSeconds",
        label: "Txn age",
        sortable: true,
        sortKey: "xactAgeSeconds",
        className: "text-sm p-2",
        render: (_v, row) => formatAgeSeconds(row.xactAgeSeconds),
      },
      {
        key: "wait",
        label: "Wait",
        className: "text-sm p-2",
        render: (_v, row) =>
          [row.waitEventType, row.waitEvent].filter(Boolean).join("/") || "—",
      },
      {
        key: "blockers",
        label: "Blockers",
        className: "text-sm p-2",
        render: (_v, row) =>
          row.blockerPids.length ? row.blockerPids.join(", ") : "—",
      },
      {
        key: "queryText",
        label: "Query",
        className: "max-w-xs font-mono text-xs p-2",
        render: (_v, row) => (
          <QueryCell queryText={row.queryText} queryHidden={row.queryHidden} />
        ),
      },
    ],
    []
  );
  return (
    <ListSection
      section={props.snap?.sessions}
      loading={props.loading}
      skeletonColumns={8}
      filter={props.filter}
      onFilterChange={props.onFilterChange}
      placeholder="Search PID, user, app, query"
      searchFields={sessionSearchFields}
      flag={SESSION_FLAG}
      columns={columns}
      keyExtractor={(row, i) => row.pid ?? i}
      emptyMessage="No sessions"
      rowClassName={(row) => (row.isBlocked ? FLAGGED_ROW_CLASS : "")}
    />
  );
}

const FLAGGED_ROW_CLASS = "bg-amber-50/60 dark:bg-amber-950/30";

const statementSearchFields = (row: HealthStatementRow) => [
  row.queryId,
  row.queryHidden ? null : row.queryText,
];

function StatementsTable(props: SectionTableProps) {
  const section = props.snap?.statements;
  const columns = useMemo<TableColumn<HealthStatementRow>[]>(
    () => [
      {
        key: "calls",
        label: "Calls",
        sortable: true,
        sortKey: "calls",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.calls),
      },
      {
        key: "totalTimeMs",
        label: "Total ms",
        sortable: true,
        sortKey: "totalTimeMs",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.totalTimeMs, 1),
      },
      {
        key: "meanTimeMs",
        label: "Mean ms",
        sortable: true,
        sortKey: "meanTimeMs",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.meanTimeMs, 2),
      },
      {
        key: "rows",
        label: "Rows",
        sortable: true,
        sortKey: "rows",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.rows),
      },
      {
        key: "queryText",
        label: "Query",
        className: "max-w-md font-mono text-xs p-2",
        render: (_v, row) => (
          <QueryCell queryText={row.queryText} queryHidden={row.queryHidden} />
        ),
      },
    ],
    []
  );
  const info = section?.info;
  return (
    <ListSection
      section={section}
      loading={props.loading}
      skeletonColumns={5}
      banner={{
        caveat:
          "Cumulative since last statistics reset — not a live slow-query feed.",
        showPgStatStatementsGuide: true,
      }}
      extra={
        info ? (
          <div class="text-xs text-neutral-500">
            {info.statsReset
              ? `Statements stats reset: ${formatHealthInspectorTimestamp(info.statsReset)}`
              : ""}
            {info.dealloc != null ? ` · Dealloc: ${info.dealloc}` : ""}
          </div>
        ) : null
      }
      filter={props.filter}
      onFilterChange={props.onFilterChange}
      placeholder="Search query text"
      searchFields={statementSearchFields}
      columns={columns}
      keyExtractor={(row, i) => row.queryId ?? i}
      emptyMessage="No statement statistics"
    />
  );
}

/** Table row plus the derived values its columns sort on. */
type TableViewRow = HealthTableRow & {
  displayName: string;
  deadRatio: number | null;
  lastVacuumAt: string | number | null;
  lastAnalyzeAt: string | number | null;
};

function toTableViewRow(row: HealthTableRow): TableViewRow {
  return {
    ...row,
    displayName: `${row.schema ?? "?"}.${row.tableName ?? "?"}${
      row.isPartitionedParent
        ? " (partitioned)"
        : row.isPartitionChild
          ? " (partition)"
          : ""
    }`,
    deadRatio: deadRowRatio(row),
    lastVacuumAt: latestHealthTimestamp(row.lastVacuum, row.lastAutovacuum),
    lastAnalyzeAt: latestHealthTimestamp(row.lastAnalyze, row.lastAutoAnalyze),
  };
}

const TABLE_FLAG = { label: "Needs vacuum", isFlagged: needsVacuum };

const tableSearchFields = (row: TableViewRow) => [row.displayName];

function TablesTable(props: SectionTableProps) {
  const section = props.snap?.tables;
  // One view row per table, so sorting sees the derived columns.
  const viewSection = useMemo(
    () =>
      section
        ? { ...section, data: section.data.map(toTableViewRow) }
        : undefined,
    [section]
  );
  const columns = useMemo<TableColumn<TableViewRow>[]>(
    () => [
      {
        key: "displayName",
        label: "Table",
        sortable: true,
        sortKey: "displayName",
        className: "text-sm p-2",
      },
      {
        key: "liveTuples",
        label: "Live (est.)",
        sortable: true,
        sortKey: "liveTuples",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.liveTuples),
      },
      {
        key: "deadTuples",
        label: "Dead (est.)",
        sortable: true,
        sortKey: "deadTuples",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.deadTuples),
      },
      {
        key: "deadRatio",
        label: "Dead %",
        sortable: true,
        sortKey: "deadRatio",
        className: "text-sm p-2",
        render: (_v, row) => formatPercent(row.deadRatio),
      },
      {
        key: "totalBytes",
        label: "Total size",
        sortable: true,
        sortKey: "totalBytes",
        className: "text-sm p-2",
        render: (_v, row) => formatInspectorBytes(row.totalBytes),
      },
      {
        key: "lastVacuumAt",
        label: "Last vacuum",
        sortable: true,
        sortKey: "lastVacuumAt",
        className: "text-sm p-2",
        render: (_v, row) => formatHealthInspectorTimestamp(row.lastVacuumAt),
      },
      {
        key: "lastAnalyzeAt",
        label: "Last analyze",
        sortable: true,
        sortKey: "lastAnalyzeAt",
        className: "text-sm p-2",
        render: (_v, row) => formatHealthInspectorTimestamp(row.lastAnalyzeAt),
      },
      {
        key: "actions",
        label: "",
        className: "text-sm p-1 text-right",
        render: (_v, row) => {
          const sql = needsVacuum(row)
            ? healthInspectorVacuumSql(row.schema, row.tableName)
            : null;
          return sql ? <CopySqlButton sql={sql} label="Copy VACUUM" /> : null;
        },
      },
    ],
    []
  );
  return (
    <ListSection
      section={viewSection}
      loading={props.loading}
      skeletonColumns={7}
      banner={{
        caveat: `${DEAD_ROW_CAVEAT} ${PARTITION_SIZE_NOTE}`,
        rankingNote: section?.sizeRankingEstimated ? SIZE_RANKING_NOTE : null,
      }}
      filter={props.filter}
      onFilterChange={props.onFilterChange}
      placeholder="Search tables"
      searchFields={tableSearchFields}
      flag={TABLE_FLAG}
      columns={columns}
      keyExtractor={(row, i) => `${row.schema}.${row.tableName}.${i}`}
      emptyMessage="No tables"
      rowClassName={(row) => (needsVacuum(row) ? FLAGGED_ROW_CLASS : "")}
    />
  );
}

type IndexViewRow = HealthIndexRow & { displayName: string };

function toIndexViewRow(row: HealthIndexRow): IndexViewRow {
  return {
    ...row,
    displayName: `${row.schema ?? "?"}.${row.indexName ?? "?"} on ${row.tableName ?? "?"}${row.isUnique ? " (unique)" : ""}`,
  };
}

const INDEX_FLAG = { label: "Unused", isFlagged: isUnusedIndex };

const indexSearchFields = (row: IndexViewRow) => [row.displayName];

function IndexesTable(props: SectionTableProps) {
  const section = props.snap?.indexes;
  const viewSection = useMemo(
    () =>
      section
        ? { ...section, data: section.data.map(toIndexViewRow) }
        : undefined,
    [section]
  );
  const columns = useMemo<TableColumn<IndexViewRow>[]>(
    () => [
      {
        key: "displayName",
        label: "Index",
        sortable: true,
        sortKey: "displayName",
        className: "text-sm p-2",
      },
      {
        key: "idxScan",
        label: "Scans",
        sortable: true,
        sortKey: "idxScan",
        className: "text-sm p-2",
        render: (_v, row) =>
          row.idxScan == null ? "—" : formatOptionalNumber(row.idxScan),
      },
      {
        key: "indexBytes",
        label: "Size",
        sortable: true,
        sortKey: "indexBytes",
        className: "text-sm p-2 min-w-24",
        render: (_v, row) => formatInspectorBytes(row.indexBytes),
      },
      {
        key: "idxTupRead",
        label: "Tup read",
        sortable: true,
        sortKey: "idxTupRead",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.idxTupRead),
      },
      {
        key: "actions",
        label: "",
        className: "text-sm p-1 text-right",
        render: (_v, row) => {
          const sql = isUnusedIndex(row)
            ? healthInspectorDropIndexSql(row.schema, row.indexName)
            : null;
          return sql ? <CopySqlButton sql={sql} label="Copy DROP" /> : null;
        },
      },
    ],
    []
  );
  return (
    <ListSection
      section={viewSection}
      loading={props.loading}
      skeletonColumns={5}
      banner={{
        caveat: INDEX_SCAN_CAVEAT,
        rankingNote: section?.sizeRankingEstimated ? SIZE_RANKING_NOTE : null,
      }}
      filter={props.filter}
      onFilterChange={props.onFilterChange}
      placeholder="Search indexes or tables"
      searchFields={indexSearchFields}
      flag={INDEX_FLAG}
      columns={columns}
      keyExtractor={(row, i) => `${row.schema}.${row.indexName}.${i}`}
      emptyMessage="No indexes"
    />
  );
}

/** Count after a tab label, plus a warning pill when something needs a look. */
function TabBadge(props: {
  section: HealthSection<unknown[]> | undefined;
  alert?: { count: number; text: string; tone: "critical" | "warning" };
}) {
  const { section, alert } = props;
  if (!section || (section.status !== "ready" && section.status !== "empty")) {
    return null;
  }
  return (
    <>
      <span class="ml-1.5 rounded-full bg-neutral-200 px-1.5 text-xs font-medium text-neutral-700 dark:bg-neutral-700 dark:text-neutral-200">
        {section.data.length}
        {section.truncated ? "+" : ""}
      </span>
      {alert && alert.count > 0 ? (
        <span
          class={cn(
            "ml-1 rounded-full px-1.5 text-xs font-medium",
            alert.tone === "critical"
              ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
              : "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-100"
          )}
        >
          {alert.count} {alert.text}
        </span>
      ) : null}
    </>
  );
}

const SNAPSHOT_AGE_TICK_MS = 30_000;

/** Current time, re-read every 30 s while enabled so "2 min ago" stays fresh. */
function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (!enabled) return;
    const id = window.setInterval(
      () => setNow(Date.now()),
      SNAPSHOT_AGE_TICK_MS
    );
    return () => window.clearInterval(id);
  }, [enabled]);
  return now;
}

/** "Collecting…", or "2 min ago (22:35) · collected in 1.2 s". */
function describeSnapshot(
  snapshot: HealthInspectorSnapshot | null,
  loading: boolean,
  now: number,
  refreshing = false
): string | null {
  if (loading) return "Collecting…";
  if (!snapshot?.finishedAt) return null;
  const age = formatSnapshotTime(snapshot.finishedAt, now);
  if (snapshot.cancelled) return `${age} · cancelled`;
  const base = `${age} · collected in ${formatCollectionDuration(snapshot.finishedAt - snapshot.startedAt)}`;
  return refreshing ? `${base} · refreshing…` : base;
}

export function DbHealthInspectorDialog(props: Props) {
  const {
    open,
    onClose,
    runtimeConnectionId,
    profileId,
    engine,
    databaseLabel,
  } = props;
  const [tab, setTab] = useState<SectionKey>("overview");
  const [filters, setFilters] =
    useState<Record<ListKey, SectionFilterState>>(INITIAL_FILTERS);
  // Off by default and per dialog session: every refresh runs several catalog
  // queries against the user's database.
  const [autoRefreshMs, setAutoRefreshMs] = useState<number | null>(null);
  const { hasPro, requirePro } = useProGate();
  // The hook re-checks Pro access itself, so collection never starts while locked.
  const { snapshot, loading, refreshing, error, refresh, cancel, supported } =
    useDbHealthInspector({
      open,
      runtimeConnectionId,
      profileId,
      engine,
      autoRefreshMs,
    });

  // Filters and auto-refresh belong to one database: reset on context change.
  useEffect(() => {
    setFilters(INITIAL_FILTERS);
    setAutoRefreshMs(null);
  }, [runtimeConnectionId, profileId, engine]);

  const now = useNow(open && Boolean(snapshot?.finishedAt));
  const snapshotStatus = describeSnapshot(snapshot, loading, now, refreshing);
  const listProps = (key: ListKey) => ({
    snap: snapshot,
    loading,
    filter: filters[key],
    onFilterChange: (next: SectionFilterState) =>
      setFilters((current) => ({ ...current, [key]: next })),
  });

  const handleClose = () => {
    cancel();
    onClose();
  };

  const openSessionsTab = () => {
    setTab("sessions");
  };

  const handleTabChange = (next: SectionKey) => {
    setTab(next);
  };

  const tabs = [
    {
      value: "overview" as const,
      label: "Overview",
      children: (
        <DbHealthInspectorOverview
          snap={snapshot}
          loading={loading}
          onOpenSessions={openSessionsTab}
        />
      ),
    },
    {
      value: "sessions" as const,
      label: "Sessions",
      badge: (
        <TabBadge
          section={snapshot?.sessions}
          alert={{
            count:
              snapshot?.sessions.data.filter((r) => r.isBlocked).length ?? 0,
            text: "blocked",
            tone: "critical",
          }}
        />
      ),
      children: <SessionsTable {...listProps("sessions")} />,
    },
    {
      value: "statements" as const,
      label: "Top statements",
      badge: <TabBadge section={snapshot?.statements} />,
      children: <StatementsTable {...listProps("statements")} />,
    },
    {
      value: "tables" as const,
      label: "Tables",
      badge: (
        <TabBadge
          section={snapshot?.tables}
          alert={{
            count: snapshot?.tables.data.filter(needsVacuum).length ?? 0,
            text: "to vacuum",
            tone: "warning",
          }}
        />
      ),
      children: <TablesTable {...listProps("tables")} />,
    },
    {
      value: "indexes" as const,
      label: "Indexes",
      badge: (
        <TabBadge
          section={snapshot?.indexes}
          alert={{
            count: snapshot?.indexes.data.filter(isUnusedIndex).length ?? 0,
            text: "unused",
            tone: "warning",
          }}
        />
      ),
      children: <IndexesTable {...listProps("indexes")} />,
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={handleClose}
      size="2xl"
      className="flex h-[80vh] flex-col overflow-hidden"
    >
      <DialogHeader className="shrink-0 border-b border-neutral-200 pr-12">
        <DialogTitle className="flex items-center gap-2">
          <DbInspectorIcon className="size-4 text-neutral-600" />
          Database Health Inspector
        </DialogTitle>
        <DialogDescription>
          Read-only PostgreSQL snapshot
          {databaseLabel ? ` · ${databaseLabel}` : ""}
          {hasPro && snapshotStatus ? ` · ${snapshotStatus}` : ""}
        </DialogDescription>
      </DialogHeader>

      {!hasPro ? (
        <>
          <DialogContent className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 py-3 text-center">
            <p class="inline-flex items-center gap-2 text-sm text-neutral-700">
              The database health inspector is a Pro feature.
              <ProBadge />
            </p>
            <Button
              type="button"
              variant="default"
              onClick={() => requirePro("health-inspector")}
            >
              Upgrade
            </Button>
          </DialogContent>
          <DialogFooter className="shrink-0 border-t border-neutral-200">
            <Button type="button" variant="outline" onClick={handleClose}>
              Close
            </Button>
          </DialogFooter>
        </>
      ) : (
        <>
          <DialogContent className="flex min-h-0 flex-1 flex-col overflow-hidden py-3">
            {!supported && engine ? (
              <div class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-50">
                Database Health Inspector currently supports PostgreSQL only.
                Connected engine: {engine}.
              </div>
            ) : null}

            {error ? (
              <div class="mb-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900 dark:border-red-700 dark:bg-red-950 dark:text-red-50">
                {error}
              </div>
            ) : null}

            {snapshot?.cancelled ? (
              <div class="mb-2 rounded-md border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-700">
                Snapshot cancelled. Partial section results above may be stale.
              </div>
            ) : null}

            <div class="flex min-h-0 flex-1 flex-col">
              <Tabs
                value={tab}
                onValueChange={handleTabChange}
                tabs={tabs}
                listClassName="rounded-t-md"
                contentClassName="mt-2 flex min-h-0 flex-col"
              />
            </div>
          </DialogContent>

          <DialogFooter className="shrink-0 border-t border-neutral-200">
            <label class="mr-auto flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-300">
              Auto-refresh
              <select
                value={autoRefreshMs == null ? "off" : String(autoRefreshMs)}
                disabled={!supported || !runtimeConnectionId}
                onInput={(e) => {
                  const value = e.currentTarget.value;
                  setAutoRefreshMs(value === "off" ? null : Number(value));
                }}
                class="h-8 rounded-md border border-neutral-300 bg-white px-2 text-sm text-neutral-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 disabled:opacity-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
              >
                <option value="off">Off</option>
                {HEALTH_INSPECTOR_AUTO_REFRESH_OPTIONS.map((ms) => (
                  <option key={ms} value={String(ms)}>
                    Every {ms / 1000} s
                  </option>
                ))}
              </select>
            </label>
            <Button type="button" variant="outline" onClick={handleClose}>
              Close
            </Button>
            {loading ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => cancel()}
                title="Cancel in-flight inspector queries"
              >
                <span class="inline-flex items-center gap-1.5">
                  <StopIcon className="size-4" />
                  Cancel
                </span>
              </Button>
            ) : (
              <Button
                type="button"
                variant="default"
                onClick={() => void refresh()}
                disabled={!supported || !runtimeConnectionId}
                title="Refresh snapshot"
              >
                <span class="inline-flex items-center gap-1.5">
                  <RefreshCwIcon
                    className={cn("size-4", refreshing && "animate-spin")}
                  />
                  Refresh
                </span>
              </Button>
            )}
          </DialogFooter>
        </>
      )}
    </Dialog>
  );
}
