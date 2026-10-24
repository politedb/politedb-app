import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Ref } from "preact";
import { cn } from "src/utils/cn";
import { TableData } from "src/components/table/TableData";
import { SqlResultSummary } from "./SqlResultSummary";
import type { SqlResultRun, SqlResultSlot } from "src/lib/tauri";
import {
  getSqlStreamSnapshot,
  useSqlStreamResult,
} from "src/screens/connection/hooks/useSqlStreamResult";
import { XIcon } from "src/components/icons";
import { Button } from "../common/Button";
import { Spinner } from "../common/Spinner";
import { OverlayScrollArea } from "../common/OverlayScrollArea";
import { ContextMenu, type MenuItem } from "../common/ContextMenu";
import type { DatabaseEngine } from "src/types";
import { MAX_PLAN_NODES } from "src/lib/query-analyzer/plan";
import { planFromResult } from "src/lib/query-analyzer/fromResult";
import type { QueryPlan } from "src/lib/query-analyzer/plan";
import { isPlanStatement } from "src/lib/queries/sql/explain";
import {
  QueryAnalyzer,
  type BaselineOption,
} from "./query-analyzer/QueryAnalyzer";
import { ProBadge } from "src/components/license/ProBadge";
import { useProGate } from "src/hooks/useProGate";
import { explainModeFor } from "src/lib/sql/analyzeClassify";

/* =============================================================================
 * UI blocks
 * ============================================================================= */

/**
 * Parsed plans, so switching between result tabs (or picking a Compare
 * baseline) does not parse a large plan again. A direct result is keyed by
 * its (immutable) result object; a stream by its operation id and content
 * version (any chunk, column or status change bumps it), since a stream
 * marked done early can still receive rows or columns.
 */
const PLAN_CACHE_SIZE = 16;
const directPlans = new WeakMap<object, Map<string, QueryPlan | null>>();
const streamPlans = new Map<string, QueryPlan | null>();

function cachedDirectPlan(
  result: object,
  variant: string,
  parse: () => QueryPlan | null
) {
  let byVariant = directPlans.get(result);
  if (!byVariant) directPlans.set(result, (byVariant = new Map()));
  if (!byVariant.has(variant)) byVariant.set(variant, parse());
  return byVariant.get(variant)!;
}

function cachedStreamPlan(key: string, parse: () => QueryPlan | null) {
  if (streamPlans.has(key)) {
    const plan = streamPlans.get(key)!;
    streamPlans.delete(key);
    streamPlans.set(key, plan); // most recently used last
    return plan;
  }
  const plan = parse();
  streamPlans.set(key, plan);
  if (streamPlans.size > PLAN_CACHE_SIZE) {
    streamPlans.delete(streamPlans.keys().next().value!);
  }
  return plan;
}

function EmptyResults(props: { focusRef?: Ref<HTMLDivElement> }) {
  return (
    // Focusable, so keyboard focus has a place after the last run closes.
    <div
      ref={props.focusRef}
      tabIndex={-1}
      class="p-6 text-center outline-none"
    >
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
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.error || "Unknown error.");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable: the text stays selectable.
    }
  };
  return (
    <div class="rounded-lg border border-rose-200 bg-rose-50 p-3">
      <div class="mb-2 flex items-center justify-between gap-2">
        <p class="text-sm font-medium text-rose-700">
          {props.title ?? "Error"}
        </p>
        <div class="flex items-center gap-2">
          {props.right ? (
            <span class="text-xs text-rose-600">{props.right}</span>
          ) : null}
          <Button
            variant="ghost"
            class="h-6 px-2 text-xs text-rose-700 hover:bg-rose-100"
            onClick={() => void copy()}
            aria-label={copied ? "Error copied" : "Copy error"}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
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

/** Shown above raw EXPLAIN rows when the visual analyzer is locked. */
function AnalyzerUpgradeBanner(props: { onUpgrade: () => void }) {
  return (
    <div class="flex shrink-0 items-center gap-2 border-b border-neutral-200 bg-blue-50/60 px-3 py-1.5 text-xs text-neutral-700 dark:bg-blue-950/40 dark:text-neutral-300">
      <ProBadge />
      <span>Visual analyzer and recommendations are Pro</span>
      <Button
        variant="ghost"
        class="ml-auto rounded-md px-2 py-0.5 text-xs font-medium text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900/40"
        onClick={props.onUpgrade}
      >
        Upgrade
      </Button>
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
  /** The keyboard closed the last run: focus must move outside the tabs. */
  onLastClosedByKeyboard?: () => void;
}) {
  const { runs, activeRunId, onSelect, onClose, onLastClosedByKeyboard } =
    props;
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    runId: string;
    runIndex: number;
  } | null>(null);

  const menuItems: MenuItem[] = ctx
    ? [
        {
          type: "item",
          label: "Close",
          onClick: () => onClose(ctx.runId),
        },
        {
          type: "item",
          label: "Close Others",
          disabled: runs.length <= 1,
          onClick: () =>
            runs.forEach((run) => {
              if (run.id !== ctx.runId) onClose(run.id);
            }),
        },
        {
          type: "item",
          label: "Close to the Right",
          disabled: ctx.runIndex >= runs.length - 1,
          onClick: () =>
            runs.slice(ctx.runIndex + 1).forEach((run) => onClose(run.id)),
        },
        { type: "sep" },
        {
          type: "item",
          label: "Close All",
          onClick: () => runs.forEach((run) => onClose(run.id)),
        },
      ]
    : [];

  const listRef = useRef<HTMLDivElement>(null);
  // After closing the focused tab, focus the tab that is selected next.
  const focusSelectedRef = useRef(false);
  useEffect(() => {
    if (!focusSelectedRef.current) return;
    focusSelectedRef.current = false;
    (
      listRef.current?.querySelector(
        '[role="tab"][aria-selected="true"]'
      ) as HTMLElement | null
    )?.focus();
  });

  // Arrow keys move between tabs; Delete closes the focused one.
  const onTabKey = (e: KeyboardEvent, idx: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (step) {
      e.preventDefault();
      const next = runs[(idx + step + runs.length) % runs.length];
      if (!next) return;
      onSelect(next.id);
      const list = (e.currentTarget as HTMLElement).parentElement;
      (
        list?.querySelector(`[data-run-id="${next.id}"]`) as HTMLElement | null
      )?.focus();
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      if (runs.length === 1) onLastClosedByKeyboard?.();
      else focusSelectedRef.current = true;
      onClose(runs[idx]!.id);
    }
  };

  return (
    <div class="shrink-0 border-b border-neutral-200 bg-neutral-100">
      <OverlayScrollArea
        contentClassName="flex items-center gap-1 px-2 pb-1"
        horizontal
        vertical={false}
      >
        <div ref={listRef} role="tablist" aria-label="Runs" class="contents">
          {runs.map((run, idx) => {
            const status = runStatus(run);
            const active = run.id === activeRunId;
            return (
              <div
                key={run.id}
                role="tab"
                data-run-id={run.id}
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                onKeyDown={(e) => onTabKey(e, idx)}
                onClick={() => onSelect(run.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setCtx({
                    x: e.clientX,
                    y: e.clientY,
                    runId: run.id,
                    runIndex: idx,
                  });
                }}
                class={cn(
                  "group flex shrink-0 items-center justify-between gap-1 rounded-md px-2 py-1 text-xs",
                  "border border-neutral-200 transition-colors",
                  active
                    ? "bg-white text-neutral-800"
                    : "bg-neutral-100 text-neutral-600 hover:bg-neutral-100"
                )}
              >
                <span class={cn("mr-0.5 text-xs", statusTone(status))}>
                  {statusMark(status)}
                </span>
                <span>{run.title}</span>
                <Button
                  variant="ghost"
                  tabIndex={-1}
                  class="invisible justify-center rounded-full p-px group-focus-within:visible group-hover:visible"
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
        </div>
      </OverlayScrollArea>

      <ContextMenu
        open={!!ctx}
        x={ctx?.x ?? 0}
        y={ctx?.y ?? 0}
        items={menuItems}
        onClose={() => setCtx(null)}
      />
    </div>
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
      <div role="tablist" aria-label="Statements" class="contents">
        {slots.map((slot, idx) => (
          <button
            key={slot.index}
            type="button"
            role="tab"
            aria-selected={idx === activeIndex}
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
      </div>
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
        // Query results are not editable: an edit here would go nowhere.
        readOnly
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
          readOnly
        />
      );
    }

    // An empty stream's "done" is provisional until the statement ends.
    if (stream.status === "done" && slot.status !== "running") {
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
  /** Measure the statement behind an estimated plan (Explain runs only). */
  onRunAnalyze?: (origin: { sql: string; connectionId?: string }) => void;
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

  // After the keyboard closes the last run, focus the empty results area.
  const emptyRef = useRef<HTMLDivElement>(null);
  const focusEmptyRef = useRef(false);
  useEffect(() => {
    if (!focusEmptyRef.current || activeRun) return;
    focusEmptyRef.current = false;
    emptyRef.current?.focus();
  });
  const safeIndex = Math.min(
    Math.max(activeIndex, 0),
    (activeRun?.slots.length ?? 0) - 1
  );
  const slot = activeRun?.slots[safeIndex];
  const streamOpId = slot?.mode === "stream" ? (slot.opId ?? null) : null;
  const stream = useSqlStreamResult(streamOpId);
  // Raw EXPLAIN is free; only the visual analyzer is Pro. Derived at render so
  // restored runs and tier changes re-evaluate.
  const { hasPro, requirePro } = useProGate();
  const {
    status: streamStatus,
    columns: streamColumns,
    getRowAt,
    totalRows: streamRowCount,
    rowsVersion: streamVersion,
  } = stream;
  // Explain runs, and statements the user ran as EXPLAIN themselves (for
  // example with ANALYZE), open in the analyzer when they return a plan.
  const explainKind: "run" | "typed" | null =
    activeRun?.kind === "explain"
      ? "run"
      : slot && props.engine && isPlanStatement(props.engine, slot.sql)
        ? "typed"
        : null;
  const plan = useMemo(() => {
    if (!explainKind || !hasPro) return null;
    const engine = props.engine;
    if (!engine || !slot || slot.status === "error") return null;
    // A typed EXPLAIN must return a real plan; never guess from a plain grid.
    const fallback = explainKind === "run";
    const variant = `${engine}:${explainKind}`;
    if (slot.mode === "direct" && slot.status === "done" && slot.result) {
      const result = slot.result;
      return cachedDirectPlan(result, variant, () =>
        planFromResult(engine, result.columns, result.rows, { fallback })
      );
    }
    if (slot.mode === "stream" && slot.opId && streamStatus === "done") {
      const key = `${slot.opId}:${streamVersion}:${streamRowCount}:${variant}`;
      return cachedStreamPlan(key, () => {
        const rows: unknown[][] = [];
        const limit = Math.min(streamRowCount, MAX_PLAN_NODES);
        for (let i = 0; i < limit; i++) {
          const row = getRowAt(i);
          if (row) rows.push(row);
        }
        return planFromResult(engine, streamColumns, rows, { fallback });
      });
    }
    return null;
  }, [
    explainKind,
    hasPro,
    props.engine,
    slot,
    streamStatus,
    streamColumns,
    streamRowCount,
    streamVersion,
    getRowAt,
  ]);

  // Earlier plans in this tab, parsed only when picked in Compare.
  const engine = props.engine;
  const baselines = useMemo<BaselineOption[]>(() => {
    if (!plan || !engine || !activeRun || !slot) return [];
    const options: BaselineOption[] = [];
    for (const run of runs) {
      // Only plans produced before the one on screen.
      if (run.createdAt > activeRun.createdAt) continue;
      for (const candidate of run.slots) {
        if (run.id === activeRun.id && candidate.index >= slot.index) continue;
        const kind =
          run.kind === "explain"
            ? "run"
            : isPlanStatement(engine, candidate.sql)
              ? "typed"
              : null;
        if (!kind || candidate.status !== "done") continue;
        const fallback = kind === "run";
        const variant = `${engine}:${kind}`;
        let load: (() => QueryPlan | null) | null = null;
        if (candidate.result) {
          const result = candidate.result;
          load = () =>
            cachedDirectPlan(result, variant, () =>
              planFromResult(engine, result.columns, result.rows, { fallback })
            );
        } else if (candidate.mode === "stream" && candidate.opId) {
          // Rows stay in the stream registry; read a bounded copy on demand.
          const opId = candidate.opId;
          load = () => {
            const snapshot = getSqlStreamSnapshot(opId);
            // Only a finished stream is cached.
            if (snapshot.status !== "done") return null;
            const key = `${opId}:${snapshot.rowsVersion}:${snapshot.totalRows}:${variant}`;
            return cachedStreamPlan(key, () => {
              const rows: unknown[][] = [];
              const limit = Math.min(snapshot.totalRows, MAX_PLAN_NODES);
              for (let i = 0; i < limit; i++) {
                const row = snapshot.getRowAt(i);
                if (row) rows.push(row);
              }
              return planFromResult(engine, snapshot.columns, rows, {
                fallback,
              });
            });
          };
        }
        if (!load) continue;
        options.push({
          id: `${run.id}:${candidate.index}`,
          title:
            run.slots.length > 1
              ? `${run.title} · ${candidate.index + 1}`
              : run.title,
          load,
        });
      }
    }
    return options.reverse();
  }, [plan, engine, runs, activeRun, slot]);

  if (!activeRun || !slot) {
    return (
      <div class="flex h-full min-h-0 flex-col bg-white">
        <EmptyResults focusRef={emptyRef} />
      </div>
    );
  }

  const slotElapsed =
    slot.startedAt !== undefined && slot.finishedAt !== undefined
      ? slot.finishedAt - slot.startedAt
      : undefined;
  // What a finished statement returned, for the summary line.
  const summary =
    slot.status === "error"
      ? null
      : slot.mode === "direct" && slot.status === "done" && slot.result
        ? {
            columns: slot.result.columns,
            rowCount: slot.result.rows.length,
            getRow: (index: number) => slot.result!.rows[index],
            elapsedMs: slotElapsed,
          }
        : slot.mode === "stream" &&
            slot.status === "done" &&
            stream.status === "done"
          ? {
              columns: stream.columns,
              rowCount: stream.totalRows,
              getRow: stream.getRowAt,
              truncated: stream.truncated,
              // The backend's own timing; the statement's start/finish if absent.
              elapsedMs: Number.isFinite(stream.elapsedMs)
                ? stream.elapsedMs
                : slotElapsed,
            }
          : null;

  const isDirectTable =
    slot.mode === "direct" && slot.status === "done" && !!slot.result;

  const isStreamTable = slot.mode === "stream" && stream.totalRows > 0;

  const shouldShowTable = isDirectTable || isStreamTable;

  const showAnalyzerUpgrade =
    explainKind !== null &&
    !hasPro &&
    slot.status !== "error" &&
    !(slot.mode === "stream" && stream.status === "error");

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
        onLastClosedByKeyboard={() => {
          focusEmptyRef.current = true;
        }}
      />

      <StatementTabs
        slots={activeRun.slots}
        activeIndex={safeIndex}
        onSelect={setActiveIndex}
      />

      {showAnalyzerUpgrade && (
        <AnalyzerUpgradeBanner
          onUpgrade={() => void requirePro("query-analyzer")}
        />
      )}

      {plan ? (
        <div class="min-h-0 flex-1">
          <QueryAnalyzer
            key={`${activeRun.id}:${slot.index}`}
            plan={plan}
            baselines={baselines}
            onRunAnalyze={
              // Only for statements Explain Analyze accepts: an estimate
              // shown because the statement can't be measured offers nothing.
              explainKind === "run" &&
              slot.sourceSql &&
              explainModeFor(slot.sourceSql) === "analyze" &&
              props.onRunAnalyze
                ? () =>
                    props.onRunAnalyze?.({
                      sql: slot.sourceSql!,
                      connectionId: activeRun.connectionId,
                    })
                : undefined
            }
          />
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

      {!plan && summary ? <SqlResultSummary {...summary} /> : null}
    </div>
  );
}
