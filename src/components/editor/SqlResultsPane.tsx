import { cn } from "src/utils/cn";
import { TableData } from "src/components/table/TableData";
import type { QueryResult } from "src/lib/tauri";

export type SqlResultSlot = {
  index: number;
  sql: string;
  status: "queued" | "running" | "done" | "error";
  result?: QueryResult;
  error?: string;
  startedAt?: number;
  finishedAt?: number;
};

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
          key={idx}
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

  const slot = slots[activeIndex];
  const hasTable = !!slot && slot.status === "done" && !!slot.result;

  return (
    <div class="flex h-full min-h-0 flex-col bg-white">
      <ResultsTabs
        slots={slots}
        activeIndex={activeIndex}
        onSelect={setActiveIndex}
      />

      <div class={cn("min-h-0 flex-1 bg-white", !hasTable && "overflow-auto")}>
        {!slot ? null : hasTable ? (
          <TableData
            key={`${windowId}:${activeIndex}`}
            columns={slot.result!.columns}
            totalRows={slot.result!.rows.length}
            getRowAt={(rowIndex) => slot.result!.rows[rowIndex]}
            onCellChange={() => {}}
          />
        ) : (
          <div class="p-3">
            {slot.status === "queued" ? (
              <SmallStateCard kind="queued" />
            ) : slot.status === "running" ? (
              <SmallStateCard kind="running" />
            ) : slot.status === "error" ? (
              <ErrorCard
                title="Query error"
                right={`Result ${activeIndex + 1}`}
                error={slot.error}
              />
            ) : (
              <SmallStateCard kind="empty" />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
