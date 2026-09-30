import { useMemo, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
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
  RefreshCwIcon,
  StopIcon,
} from "src/components/icons";
import { useDbHealthInspector } from "@root/src/hooks/useDbHealthInspector";
import type { DatabaseEngine } from "src/types";
import { formatBytesSize } from "src/utils/convert";
import { cn } from "src/utils/cn";
import {
  formatHealthInspectorTimestamp,
  latestHealthTimestamp,
} from "src/lib/healthInspector/format";
import {
  DEAD_ROW_CAVEAT,
  INDEX_SCAN_CAVEAT,
  PARTITION_SIZE_NOTE,
  formatAgeSeconds,
  formatOptionalNumber,
} from "src/lib/healthInspector/signals";
import type {
  HealthIndexRow,
  HealthInspectorSnapshot,
  HealthSection,
  HealthSessionRow,
  HealthStatementRow,
  HealthTableRow,
} from "src/lib/healthInspector/types";
import { DbHealthInspectorOverview } from "./DbHealthInspectorOverview";

type SectionKey = "overview" | "sessions" | "statements" | "tables" | "indexes";

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
  showPgStatStatementsGuide?: boolean;
}) {
  const { section, loading, caveat, showPgStatStatementsGuide } = props;
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
  return section.truncated || caveat ? (
    <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
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

function SessionsTable(props: {
  snap: HealthInspectorSnapshot | null;
  loading: boolean;
}) {
  if (props.loading) {
    return <TableSectionSkeleton columns={8} />;
  }
  const section = props.snap?.sessions;
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
        key: "state",
        label: "State",
        sortable: true,
        sortKey: "state",
        className: "text-sm p-2",
      },
      {
        key: "isExecuting",
        label: "Exec",
        className: "text-sm p-2",
        render: (_v, row) => (row.isExecuting ? "yes" : "idle"),
      },
      {
        key: "queryAgeSeconds",
        label: "Query age",
        className: "text-sm p-2",
        render: (_v, row) => formatAgeSeconds(row.queryAgeSeconds),
      },
      {
        key: "xactAgeSeconds",
        label: "Txn age",
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
  if (!section) return null;
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2">
      <SectionBanner section={section} loading={props.loading} />
      {section.status === "ready" || section.status === "empty" ? (
        <div class="min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-200">
          <Table
            columns={columns}
            data={section.data}
            keyExtractor={(row, i) => row.pid ?? i}
            emptyMessage="No sessions"
            enableSort
          />
        </div>
      ) : null}
    </div>
  );
}

function StatementsTable(props: {
  snap: HealthInspectorSnapshot | null;
  loading: boolean;
}) {
  if (props.loading) {
    return <TableSectionSkeleton columns={5} />;
  }
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
  if (!section) return null;
  const info = section.info;
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2">
      <SectionBanner
        section={section}
        loading={props.loading}
        caveat="Cumulative since last statistics reset — not a live slow-query feed."
        showPgStatStatementsGuide
      />
      {info ? (
        <div class="text-xs text-neutral-500">
          {info.statsReset
            ? `Statements stats reset: ${formatHealthInspectorTimestamp(info.statsReset)}`
            : ""}
          {info.dealloc != null ? ` · Dealloc: ${info.dealloc}` : ""}
        </div>
      ) : null}
      {section.status === "ready" || section.status === "empty" ? (
        <div class="min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-200">
          <Table
            columns={columns}
            data={section.data}
            keyExtractor={(row, i) => row.queryId ?? i}
            emptyMessage="No statement statistics"
            enableSort
          />
        </div>
      ) : null}
    </div>
  );
}

function TablesTable(props: {
  snap: HealthInspectorSnapshot | null;
  loading: boolean;
}) {
  if (props.loading) {
    return <TableSectionSkeleton columns={6} />;
  }
  const section = props.snap?.tables;
  const columns = useMemo<TableColumn<HealthTableRow>[]>(
    () => [
      {
        key: "name",
        label: "Table",
        className: "text-sm p-2",
        render: (_v, row) =>
          `${row.schema ?? "?"}.${row.tableName ?? "?"}${
            row.isPartitionedParent
              ? " (partitioned)"
              : row.isPartitionChild
                ? " (partition)"
                : ""
          }`,
      },
      {
        key: "liveTuples",
        label: "Live (est.)",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.liveTuples),
      },
      {
        key: "deadTuples",
        label: "Dead (est.)",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.deadTuples),
      },
      {
        key: "totalBytes",
        label: "Total size",
        className: "text-sm p-2",
        render: (_v, row) =>
          row.totalBytes == null
            ? "—"
            : formatBytesSize(row.totalBytes, { fractionDigits: 1 }),
      },
      {
        key: "lastVacuum",
        label: "Last vacuum",
        className: "text-sm p-2",
        render: (_v, row) =>
          formatHealthInspectorTimestamp(
            latestHealthTimestamp(row.lastVacuum, row.lastAutovacuum)
          ),
      },
      {
        key: "lastAnalyze",
        label: "Last analyze",
        className: "text-sm p-2",
        render: (_v, row) =>
          formatHealthInspectorTimestamp(
            latestHealthTimestamp(row.lastAnalyze, row.lastAutoAnalyze)
          ),
      },
    ],
    []
  );
  if (!section) return null;
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2">
      <SectionBanner
        section={section}
        loading={props.loading}
        caveat={`${DEAD_ROW_CAVEAT} ${PARTITION_SIZE_NOTE}`}
      />
      {section.status === "ready" || section.status === "empty" ? (
        <div class="min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-200">
          <Table
            columns={columns}
            data={section.data}
            keyExtractor={(row, i) => `${row.schema}.${row.tableName}.${i}`}
            emptyMessage="No tables"
            enableSort={false}
          />
        </div>
      ) : null}
    </div>
  );
}

function IndexesTable(props: {
  snap: HealthInspectorSnapshot | null;
  loading: boolean;
}) {
  if (props.loading) {
    return <TableSectionSkeleton columns={4} />;
  }
  const section = props.snap?.indexes;
  const columns = useMemo<TableColumn<HealthIndexRow>[]>(
    () => [
      {
        key: "name",
        label: "Index",
        className: "text-sm p-2",
        render: (_v, row) =>
          `${row.schema ?? "?"}.${row.indexName ?? "?"} on ${row.tableName ?? "?"}`,
      },
      {
        key: "idxScan",
        label: "Scans",
        className: "text-sm p-2",
        render: (_v, row) =>
          row.idxScan == null ? "—" : formatOptionalNumber(row.idxScan),
      },
      {
        key: "indexBytes",
        label: "Size",
        className: "text-sm p-2",
        render: (_v, row) =>
          row.indexBytes == null
            ? "—"
            : formatBytesSize(row.indexBytes, { fractionDigits: 1 }),
      },
      {
        key: "idxTupRead",
        label: "Tup read",
        className: "text-sm p-2",
        render: (_v, row) => formatOptionalNumber(row.idxTupRead),
      },
    ],
    []
  );
  if (!section) return null;
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2">
      <SectionBanner
        section={section}
        loading={props.loading}
        caveat={INDEX_SCAN_CAVEAT}
      />
      {section.status === "ready" || section.status === "empty" ? (
        <div class="min-h-0 flex-1 overflow-hidden rounded-lg border border-neutral-200">
          <Table
            columns={columns}
            data={section.data}
            keyExtractor={(row, i) => `${row.schema}.${row.indexName}.${i}`}
            emptyMessage="No indexes"
            enableSort={false}
          />
        </div>
      ) : null}
    </div>
  );
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
  const { snapshot, loading, error, refresh, cancel, supported } =
    useDbHealthInspector({
      open,
      runtimeConnectionId,
      profileId,
      engine,
    });

  const handleClose = () => {
    cancel();
    onClose();
  };

  const openSessionsTab = () => {
    if (loading) return;
    setTab("sessions");
  };

  const handleTabChange = (next: SectionKey) => {
    if (loading) return;
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
      children: <SessionsTable snap={snapshot} loading={loading} />,
    },
    {
      value: "statements" as const,
      label: "Top statements",
      children: <StatementsTable snap={snapshot} loading={loading} />,
    },
    {
      value: "tables" as const,
      label: "Tables",
      children: <TablesTable snap={snapshot} loading={loading} />,
    },
    {
      value: "indexes" as const,
      label: "Indexes",
      children: <IndexesTable snap={snapshot} loading={loading} />,
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
        <DialogTitle>Database Health Inspector</DialogTitle>
        <p class="mt-1 text-sm text-neutral-600">
          Read-only PostgreSQL snapshot
          {databaseLabel ? ` · ${databaseLabel}` : ""}
          {snapshot?.startedAt
            ? ` · Started ${formatCollectedAt(snapshot.startedAt)}`
            : ""}
        </p>
      </DialogHeader>

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
            disabled={loading}
            listClassName="rounded-t-md"
            contentClassName="mt-2 flex min-h-0 flex-col"
          />
        </div>
      </DialogContent>

      <DialogFooter className="shrink-0 border-t border-neutral-200">
        <Button
          type="button"
          variant="outline"
          onClick={() => void refresh()}
          disabled={loading || !supported || !runtimeConnectionId}
          title="Refresh snapshot"
        >
          <span class="inline-flex items-center gap-1.5">
            <RefreshCwIcon
              className={cn("size-4", loading && "animate-spin")}
            />
            Refresh
          </span>
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => cancel()}
          disabled={!loading}
          title="Cancel in-flight inspector queries"
        >
          <span class="inline-flex items-center gap-1.5">
            <StopIcon className="size-4" />
            Cancel
          </span>
        </Button>
        <Button type="button" variant="default" onClick={handleClose}>
          Close
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
