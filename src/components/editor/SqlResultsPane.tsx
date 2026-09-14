import { useMemo } from "preact/hooks";
import { cn } from "src/utils/cn";
import { TableData } from "src/components/table/TableData";
import { TableFooter } from "src/components/table/TableFooter";
import type { SqlResultRun, SqlResultSlot } from "src/lib/tauri";
import { useSqlStreamResult } from "src/screens/connection/hooks/useSqlStreamResult";
import { XIcon } from "src/components/icons";
import { Button } from "../common/Button";
import { Spinner } from "../common/Spinner";
import { OverlayScrollArea } from "../common/OverlayScrollArea";
import type { DatabaseEngine } from "src/types";
import { planFromResult } from "src/lib/query-analyzer/plan";
import { QueryAnalyzer } from "./query-analyzer/QueryAnalyzer";

/* =============================================================================
 * UI blocks
 * ============================================================================= */

function EmptyResults() {
  return (
    <div class="p-6 text-center">
      <p class="text-sm text-neutral-500">Run a query to see results here.</p>
    </div>
  );
}

function SmallStateCard(props: { kind: "queued" | "running" | "empty" }) {
  if (props.kind === "queued") {
    return (
      <div class="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
        <span class="text-neutral-400">•</span>
        <span>Queued...</span>
      </div>
    );
  }

  if (props.kind === "running") {
    return (
      <div class="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
        <div class="h-4 w-4 animate-spin rounded-full border-b-2 border-blue-600" />
        <span>Running...</span>
      </div>
    );
  }

  return (
    <div class="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
      <span class="text-neutral-400">-</span>
      <span>No result.</span>
    </div>
  );
}

function ErrorCard(props: { title?: string; right?: string; error?: string }) {
  return (
    <div class="rounded-lg border border-rose-200 bg-rose-50 p-3">
      <div class="mb-2 flex items-center justify-between">
        <p class="text-sm font-medium text-rose-700">
          {props.title ?? "Error"}
        </p>
        {props.right ? (
          <span class="text-xs text-rose-600">{props.right}</span>
        ) : null}
      </div>

      <OverlayScrollArea
        className="max-h-50 rounded-md bg-white/60"
        contentClassName="p-2 font-mono text-xs whitespace-pre-wrap text-neutral-800"
        horizontal
        vertical
      >
        {props.error || "Unknown error."}
      </OverlayScrollArea>
    </div>
  );
}

/* =============================================================================
 * Tabs
 * ============================================================================= */

function statusMark(status: SqlResultSlot["status"]) {
  if (status === "queued") return "•";
  if (status === "running") return <Spinner className="size-3 text-blue-600" />;
  if (status === "done") return "OK";
  return "!";
}

function statusTone(status: SqlResultSlot["status"]) {
  if (status === "running") return "text-blue-700";
  if (status === "done") return "text-emerald-700";
  if (status === "error") return "text-rose-700";
  return "text-neutral-400";
}

function runStatus(run: SqlResultRun): SqlResultSlot["status"] {
  if (run.slots.some((slot) => slot.status === "error")) return "error";
  if (run.slots.some((slot) => slot.status === "running")) return "running";
  if (run.slots.some((slot) => slot.status === "queued")) return "queued";
  return "done";
}

function RunTabs(props: {
  runs: SqlResultRun[];
  activeRunId: string;
  onSelect: (runId: string) => void;
  onClose: (runId: string) => void;
}) {
  const { runs, activeRunId, onSelect, onClose } = props;

  return (
    <OverlayScrollArea
      className="shrink-0 border-b border-neutral-200 bg-neutral-100"
      contentClassName="flex items-center gap-1 px-2 py-1"
      horizontal
      vertical={false}
    >
      {runs.map((run) => {
        const status = runStatus(run);
        const active = run.id === activeRunId;
        return (
          <div
            key={run.id}
            onClick={() => onSelect(run.id)}
            class={cn(
              "group flex shrink-0 items-center justify-between gap-1 rounded-md px-2 py-1 text-xs",
              active
                ? "bg-white text-neutral-800 ring-1 ring-neutral-200"
                : "bg-neutral-200/60 text-neutral-600 hover:bg-neutral-200/40"
            )}
          >
            <span class={cn("mr-0.5 text-xs", statusTone(status))}>
              {statusMark(status)}
            </span>
            <span>{run.title}</span>
            <Button
              variant="ghost"
              class="invisible justify-center rounded-full p-px group-hover:visible"
              aria-label={`Close ${run.title}`}
              title={`Close ${run.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(run.id);
              }}
            >
              <XIcon className="size-3" />
            </Button>
          </div>
        );
      })}
    </OverlayScrollArea>
  );
}

function StatementTabs(props: {
  slots: SqlResultSlot[];
  activeIndex: number;
  onSelect: (idx: number) => void;
}) {
  const { slots, activeIndex, onSelect } = props;
  if (slots.length <= 1) return null;

  return (
    <OverlayScrollArea
      className="shrink-0 border-b border-neutral-200 bg-neutral-50"
      contentClassName="flex items-center gap-1 px-2 py-1"
      horizontal
      vertical={false}
    >
      {slots.map((slot, idx) => (
        <button
          key={slot.index}
          onClick={() => onSelect(idx)}
          class={cn(
            "inline-flex shrink-0 items-center gap-2 rounded-md px-2 py-1 text-xs",
            idx === activeIndex
              ? "bg-white text-neutral-800 ring-1 ring-neutral-200"
              : "text-neutral-600 hover:bg-neutral-100"
          )}
          title={slot.sql.slice(0, 400)}
        >
          <span>Statement {idx + 1}</span>
          <span class={cn("text-[10px]", statusTone(slot.status))}>
            {statusMark(slot.status)}
          </span>
        </button>
      ))}
    </OverlayScrollArea>
  );
}

/* =============================================================================
 * Content
 * ============================================================================= */

function ResultsContent(props: {
  windowId: string;
  runId: string;
  slot: SqlResultSlot;
  safeIndex: number;
  stream: ReturnType<typeof useSqlStreamResult> | null;
}) {
  const { windowId, runId, slot, safeIndex, stream } = props;

  const isDirect = slot.mode === "direct";
  const isStream = slot.mode === "stream" && !!slot.opId;

  if (slot.status === "error") {
    return (
      <div class="p-3">
        <ErrorCard
          title="Query error"
          right={`Statement ${safeIndex + 1}`}
          error={slot.error}
        />
      </div>
    );
  }

  if (isStream && stream?.status === "error") {
    return (
      <div class="p-3">
        <ErrorCard
          title="Query error"
          right={`Statement ${safeIndex + 1}`}
          error={stream.error}
        />
      </div>
    );
  }

  if (isDirect && slot.status === "done" && slot.result) {
    return (
      <TableData
        key={`${windowId}:${runId}:${slot.index}:direct`}
        columns={slot.result.columns}
        baseRows={slot.result.rows.length}
        totalRows={slot.result.rows.length}
        getRowAt={(rowIndex) => slot.result!.rows[rowIndex]}
        rowsVersion={0}
        onCellChange={() => {}}
      />
    );
  }

  if (isStream && stream) {
    if (stream.totalRows > 0) {
      return (
        <TableData
          key={`${windowId}:${runId}:${slot.index}:stream`}
          columns={stream.columns}
          baseRows={stream.totalRows}
          totalRows={stream.totalRows}
          getRowAt={stream.getRowAt}
          rowsVersion={stream.rowsVersion}
          onCellChange={() => {}}
        />
      );
    }

    if (stream.status === "done") {
      return (
        <div class="p-3">
          <SmallStateCard kind="empty" />
        </div>
      );
    }

    return (
      <div class="p-3">
        <SmallStateCard kind="running" />
      </div>
    );
  }

  if (slot.status === "done") {
    return (
      <div class="p-3">
        <SmallStateCard kind="empty" />
      </div>
    );
  }

  return (
    <div class="p-3">
      <SmallStateCard kind={slot.status === "queued" ? "queued" : "running"} />
    </div>
  );
}

/* =============================================================================
 * Main pane
 * ============================================================================= */

export function SqlResultsPane(props: {
  engine?: DatabaseEngine;
  windowId: string;
  runs: SqlResultRun[];
  activeRunId: string | null;
  setActiveRunId: (runId: string) => void;
  activeIndex: number;
  setActiveIndex: (idx: number) => void;
  onCloseRun: (runId: string) => void;
}) {
  const {
    windowId,
    runs,
    activeRunId,
    setActiveRunId,
    activeIndex,
    setActiveIndex,
    onCloseRun,
  } = props;

  const activeRun =
    runs.find((run) => run.id === activeRunId) ?? runs[runs.length - 1];
  const safeIndex = Math.min(
    Math.max(activeIndex, 0),
    (activeRun?.slots.length ?? 0) - 1
  );
  const slot = activeRun?.slots[safeIndex];
  const streamOpId = slot?.mode === "stream" ? (slot.opId ?? null) : null;
  const stream = useSqlStreamResult(streamOpId);
  const {
    status: streamStatus,
    columns: streamColumns,
    getRowAt,
    totalRows: streamRowCount,
  } = stream;
  const streamFirstRow = streamStatus === "done" ? getRowAt(0) : undefined;
  const plan = useMemo(() => {
    if (props.engine !== "postgres" || !slot || slot.status === "error")
      return null;
    if (slot.mode === "direct" && slot.status === "done" && slot.result) {
      return planFromResult(
        slot.result.columns,
        slot.result.rows[0],
        slot.result.rows.length
      );
    }
    if (slot.mode === "stream" && streamStatus === "done") {
      return planFromResult(streamColumns, streamFirstRow, streamRowCount);
    }
    return null;
  }, [
    props.engine,
    slot,
    streamStatus,
    streamColumns,
    streamFirstRow,
    streamRowCount,
  ]);

  if (!activeRun || !slot) {
    return (
      <div class="flex h-full min-h-0 flex-col bg-white">
        <EmptyResults />
      </div>
    );
  }

  const footerTotalRows =
    slot.mode === "direct" && slot.status === "done" && slot.result
      ? slot.result.rows.length
      : slot.mode === "stream" && stream
        ? stream.totalRows
        : 0;

  const footerLoadedMax = footerTotalRows > 0 ? footerTotalRows - 1 : -1;
  const footerLimit = Math.max(footerTotalRows, 50);
  const footerOffset = 0;

  const isDirectTable =
    slot.mode === "direct" && slot.status === "done" && !!slot.result;

  const isStreamTable = slot.mode === "stream" && stream.totalRows > 0;

  const shouldShowTable = isDirectTable || isStreamTable;

  return (
    <div class="flex h-full min-h-0 flex-col bg-white">
      <RunTabs
        runs={runs}
        activeRunId={activeRun.id}
        onSelect={(runId) => {
          setActiveRunId(runId);
          setActiveIndex(0);
        }}
        onClose={onCloseRun}
      />

      <StatementTabs
        slots={activeRun.slots}
        activeIndex={safeIndex}
        onSelect={setActiveIndex}
      />

      {plan ? (
        <div class="min-h-0 flex-1">
          <QueryAnalyzer key={`${activeRun.id}:${slot.index}`} plan={plan} />
        </div>
      ) : shouldShowTable ? (
        <div class="min-h-0 flex-1 bg-white">
          <ResultsContent
            windowId={windowId}
            runId={activeRun.id}
            slot={slot}
            safeIndex={safeIndex}
            stream={slot.mode === "stream" ? stream : null}
          />
        </div>
      ) : (
        <OverlayScrollArea
          className="min-h-0 flex-1 bg-white"
          horizontal
          vertical
        >
          <ResultsContent
            windowId={windowId}
            runId={activeRun.id}
            slot={slot}
            safeIndex={safeIndex}
            stream={null}
          />
        </OverlayScrollArea>
      )}

      {!plan && (
        <TableFooter
          className="justify-center"
          viewMode="data"
          onViewModeChange={() => {}}
          structPaneTab="columns"
          filterBarVisible={false}
          limit={footerLimit}
          offset={footerOffset}
          loadedMax={footerLoadedMax}
          totalRows={footerTotalRows}
          rowCountIsEstimated={false}
          onCountExact={undefined}
          onPageChange={() => {}}
          onAddRow={() => {}}
          onAddColumn={() => {}}
          onAddIndex={() => {}}
          onFilters={() => {}}
          readOnly
          showViewToggle={false}
          showActions={false}
          showFiltersAndPaging={false}
        />
      )}
    </div>
  );
}
