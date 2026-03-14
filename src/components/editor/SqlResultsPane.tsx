import { useEffect, useState } from "preact/hooks";
import { cn } from "src/utils/cn";
import { TableData } from "src/components/table/TableData";
import { TableFooter } from "src/components/table/TableFooter";
import type { SqlResultSlot } from "src/lib/tauri";
import { useSqlStreamResult } from "src/screens/connection/hooks/useSqlStreamResult";

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
        <span>Queued…</span>
      </div>
    );
  }

  if (props.kind === "running") {
    return (
      <div class="inline-flex items-center gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
        <div class="h-4 w-4 animate-spin rounded-full border-b-2 border-blue-600" />
        <span>Running…</span>
      </div>
    );
  }

  return (
    <div class="inline-flex items-center gap-2 rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm text-neutral-600">
      <span class="text-neutral-400">—</span>
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

      <pre class="max-h-50 overflow-auto rounded-md bg-white/60 p-2 font-mono text-xs whitespace-pre-wrap text-neutral-800">
        {props.error || "Unknown error."}
      </pre>
    </div>
  );
}

/* =============================================================================
 * Tabs
 * ============================================================================= */

function statusMark(status: SqlResultSlot["status"]) {
  if (status === "queued") return "•";
  if (status === "running") return "…";
  if (status === "done") return "✓";
  return "!";
}

function statusTone(status: SqlResultSlot["status"]) {
  if (status === "running") return "text-blue-700";
  if (status === "done") return "text-emerald-700";
  if (status === "error") return "text-rose-700";
  return "text-neutral-400";
}

function ResultsTabs(props: {
  slots: SqlResultSlot[];
  activeIndex: number;
  onSelect: (idx: number) => void;
}) {
  const { slots, activeIndex, onSelect } = props;

  return (
    <div class="flex items-center gap-1 border-b border-neutral-200 bg-neutral-50 px-2 py-1">
      {slots.map((s, idx) => (
        <button
          key={s.index}
          onClick={() => onSelect(idx)}
          class={cn(
            "inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs",
            idx === activeIndex
              ? "bg-white text-neutral-800 ring-1 ring-neutral-200"
              : "text-neutral-600 hover:bg-neutral-100"
          )}
          title={s.sql.slice(0, 400)}
        >
          <span>Results {idx + 1}</span>
          <span class={cn("text-[10px]", statusTone(s.status))}>
            {statusMark(s.status)}
          </span>
        </button>
      ))}
    </div>
  );
}

/* =============================================================================
 * Content
 * ============================================================================= */

function ResultsContent(props: {
  windowId: string;
  slot: SqlResultSlot;
  safeIndex: number;
  stream: ReturnType<typeof useSqlStreamResult> | null;
}) {
  const { windowId, slot, safeIndex, stream } = props;

  const isDirect = slot.mode === "direct";
  const isStream = slot.mode === "stream" && !!slot.opId;

  // slot error first
  if (slot.status === "error") {
    return (
      <div class="p-3">
        <ErrorCard
          title="Query error"
          right={`Result ${safeIndex + 1}`}
          error={slot.error}
        />
      </div>
    );
  }

  // stream error
  if (isStream && stream?.status === "error") {
    return (
      <div class="p-3">
        <ErrorCard
          title="Query error"
          right={`Result ${safeIndex + 1}`}
          error={stream.error}
        />
      </div>
    );
  }

  // direct data
  if (isDirect && slot.status === "done" && slot.result) {
    return (
      <TableData
        key={`${windowId}:${slot.index}:direct`}
        columns={slot.result.columns}
        baseRows={slot.result.rows.length}
        totalRows={slot.result.rows.length}
        getRowAt={(rowIndex) => slot.result!.rows[rowIndex]}
        rowsVersion={0}
        onCellChange={() => {}}
      />
    );
  }

  // stream data
  if (isStream && stream) {
    // ✅ show as soon as we have rows (do not wait for done)
    if (stream.totalRows > 0) {
      return (
        <TableData
          key={`${windowId}:${slot.index}:stream`}
          columns={stream.columns}
          baseRows={stream.totalRows}
          totalRows={stream.totalRows}
          getRowAt={stream.getRowAt}
          rowsVersion={stream.rowsVersion}
          onCellChange={() => {}}
        />
      );
    }

    // done + empty
    if (stream.status === "done") {
      return (
        <div class="p-3">
          <SmallStateCard kind="empty" />
        </div>
      );
    }

    // running + no rows yet
    return (
      <div class="p-3">
        <SmallStateCard kind="running" />
      </div>
    );
  }

  // non-table terminal
  if (slot.status === "done") {
    return (
      <div class="p-3">
        <SmallStateCard kind="empty" />
      </div>
    );
  }

  // queued/running fallback
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
  windowId: string;
  slots: SqlResultSlot[] | null;
  activeIndex: number;
  setActiveIndex: (idx: number) => void;
}) {
  const { windowId, slots, activeIndex, setActiveIndex } = props;

  if (!slots || slots.length === 0) {
    return (
      <div class="flex h-full min-h-0 flex-col bg-white">
        <EmptyResults />
      </div>
    );
  }

  const safeIndex = Math.min(Math.max(activeIndex, 0), slots.length - 1);
  const slot = slots[safeIndex];

  // ✅ IMPORTANT: use STATE (not ref) so hook re-subscribes when opId appears
  const [streamOpId, setStreamOpId] = useState<string | null>(null);

  useEffect(() => {
    if (slot?.mode === "stream" && slot.opId) {
      setStreamOpId(slot.opId);
    } else {
      setStreamOpId(null);
    }
  }, [slot?.mode, slot?.opId]);

  const stream = useSqlStreamResult(streamOpId);

  const footerTotalRows =
    slot.mode === "direct" && slot.status === "done" && slot.result
      ? slot.result.rows.length
      : slot.mode === "stream" && stream
        ? stream.totalRows
        : 0;

  const footerLoadedMax = footerTotalRows > 0 ? footerTotalRows - 1 : -1;
  const footerLimit = Math.max(footerTotalRows, 50);
  const footerOffset = 0;

  // Decide scroll mode: tables manage their own scrolling
  const isDirectTable =
    slot.mode === "direct" && slot.status === "done" && !!slot.result;

  const isStreamTable = slot.mode === "stream" && stream.totalRows > 0;

  const shouldShowTable = isDirectTable || isStreamTable;

  return (
    <div class="flex h-full min-h-0 flex-col bg-white">
      <ResultsTabs
        slots={slots}
        activeIndex={safeIndex}
        onSelect={setActiveIndex}
      />

      <div
        class={cn(
          "min-h-0 flex-1 bg-white",
          !shouldShowTable && "overflow-auto"
        )}
      >
        <ResultsContent
          windowId={windowId}
          slot={slot}
          safeIndex={safeIndex}
          stream={slot.mode === "stream" ? stream : null}
        />
      </div>

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
    </div>
  );
}
