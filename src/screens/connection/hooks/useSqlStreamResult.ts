import { useEffect, useMemo, useState } from "preact/hooks";
import type { ColumnMeta, OperationDone, TableChunk } from "src/lib/tauri";
import { operationBus } from "src/lib/tauri/operationBus";

/* =============================================================================
 * Types
 * ============================================================================= */

type StreamStatus = "idle" | "running" | "done" | "error";

export type SqlStreamResult = {
  status: StreamStatus;
  columns: ColumnMeta[];
  totalRows: number;
  rowsVersion: number;
  error?: string;
  getRowAt: (rowIndex: number) => unknown[] | undefined;
};

type Listener = () => void;

type StreamEntry = {
  opId: string;
  status: StreamStatus;

  columns: ColumnMeta[];
  rowsByIdx: Map<number, unknown[]>;
  maxIdx: number;
  totalRows: number;

  version: number;
  listeners: Set<Listener>;

  started: boolean;
  unsub: (() => void) | null;

  // failsafe
  lastEventAt: number;
  idleTimer: number | null;

  error?: string;
};

/* =============================================================================
 * Registry
 * ============================================================================= */

const streams = new Map<string, StreamEntry>();

/* =============================================================================
 * Helpers
 * ============================================================================= */

function normalizeColumns(cols: any): ColumnMeta[] {
  if (!Array.isArray(cols)) return [];
  return cols.map((c: any) => ({
    name: String(c?.name ?? ""),
    db_type: String(c?.db_type ?? ""),
  }));
}

function buildFallbackColumnsFromArrayRow(row: unknown[]): ColumnMeta[] {
  return row.map((_, i) => ({
    name: `col_${i + 1}`,
    db_type: "",
  }));
}

function buildFallbackColumnsFromObjectRow(
  row: Record<string, any>
): ColumnMeta[] {
  return Object.keys(row).map((k) => ({
    name: k,
    db_type: "",
  }));
}

function safeOffset(chunk: TableChunk, fallback: number) {
  const off = Number((chunk as any)?.row_offset);
  return Number.isFinite(off) && off >= 0 ? off : fallback;
}

function pickDoneColumns(done: any) {
  return (
    done?.columns ??
    done?.done?.columns ??
    done?.result?.columns ??
    done?.payload?.columns ??
    null
  );
}

function pickDoneRowCount(done: any) {
  return (
    done?.row_count ??
    done?.rowCount ??
    done?.done?.row_count ??
    done?.result?.row_count ??
    done?.payload?.row_count ??
    null
  );
}

function notify(entry: StreamEntry) {
  entry.version++;
  for (const fn of entry.listeners) fn();
}

function getOrCreate(opId: string): StreamEntry {
  let entry = streams.get(opId);
  if (!entry) {
    entry = {
      opId,
      status: "idle",

      columns: [],
      rowsByIdx: new Map(),
      maxIdx: -1,
      totalRows: 0,

      version: 0,
      listeners: new Set(),

      started: false,
      unsub: null,

      lastEventAt: Date.now(),
      idleTimer: null,
    };
    streams.set(opId, entry);
  }
  return entry;
}

/* =============================================================================
 * Start stream
 * ============================================================================= */

export function ensureSqlStreamStarted(opId: string) {
  const entry = getOrCreate(opId);
  if (entry.started) return;
  console.log(
    "[hook] ensure start",
    opId,
    "FILE=connection/hooks/useSqlStreamResult"
  );
  entry.started = true;
  entry.status = "running";
  entry.lastEventAt = Date.now();
  notify(entry);

  // ✅ failsafe: if BE never sends done for empty result, stop spinning
  if (entry.idleTimer != null) window.clearInterval(entry.idleTimer);
  entry.idleTimer = window.setInterval(() => {
    if (entry.status !== "running") return;

    const idleMs = Date.now() - entry.lastEventAt;

    // no rows received yet + idle => treat as empty done
    if (entry.maxIdx < 0 && idleMs > 1200) {
      entry.status = "done";
      entry.totalRows = 0;
      notify(entry);

      if (entry.idleTimer != null) window.clearInterval(entry.idleTimer);
      entry.idleTimer = null;
    }
  }, 300);

  operationBus
    .subscribe(opId, {
      onChunk: (chunk: TableChunk) => {
        if (entry.status === "error" || entry.status === "done") return;
        console.log("[hook] chunk", opId, chunk.seq, chunk.rows?.length);
        entry.lastEventAt = Date.now();

        const maybeCols = (chunk as any)?.columns;
        if (maybeCols && entry.columns.length === 0) {
          entry.columns = normalizeColumns(maybeCols);
        }

        const rows = chunk.rows ?? [];
        if (!rows.length) return;

        // infer columns if missing
        if (entry.columns.length === 0) {
          const first = rows[0];
          if (Array.isArray(first)) {
            entry.columns = buildFallbackColumnsFromArrayRow(first);
          } else if (first && typeof first === "object") {
            entry.columns = buildFallbackColumnsFromObjectRow(
              first as Record<string, any>
            );
          }
        }

        const base = safeOffset(chunk, entry.maxIdx + 1);

        for (let i = 0; i < rows.length; i++) {
          const idx = base + i;
          entry.rowsByIdx.set(idx, rows[i]);
          if (idx > entry.maxIdx) entry.maxIdx = idx;
        }

        entry.totalRows = Math.max(entry.totalRows, base + rows.length);
        notify(entry);
      },

      onDone: (done: OperationDone) => {
        if (entry.status === "error") return;

        entry.lastEventAt = Date.now();

        const doneCols = pickDoneColumns(done);
        if (doneCols) entry.columns = normalizeColumns(doneCols);

        const finalCount = Number(pickDoneRowCount(done));
        if (Number.isFinite(finalCount) && finalCount >= 0) {
          entry.totalRows = finalCount;
        } else {
          entry.totalRows = Math.max(entry.totalRows, entry.maxIdx + 1);
        }

        entry.status = "done";
        notify(entry);

        if (entry.idleTimer != null) window.clearInterval(entry.idleTimer);
        entry.idleTimer = null;
      },

      onError: (err: any) => {
        entry.lastEventAt = Date.now();
        entry.status = "error";
        entry.error = String(err?.message ?? err ?? "Unknown error");
        notify(entry);

        if (entry.idleTimer != null) window.clearInterval(entry.idleTimer);
        entry.idleTimer = null;
      },
    })
    .then((unsub) => {
      entry.unsub = unsub;
    })
    .catch((e) => {
      entry.status = "error";
      entry.error = String((e as any)?.message ?? e ?? "Unknown error");
      notify(entry);

      if (entry.idleTimer != null) window.clearInterval(entry.idleTimer);
      entry.idleTimer = null;
    });
}

/* =============================================================================
 * Cleanup
 * ============================================================================= */

export function clearSqlStream(opId: string) {
  console.log("[hook] clear", opId, new Error().stack);
  const entry = streams.get(opId);
  if (!entry) return;

  try {
    entry.unsub?.();
  } catch {}

  if (entry.idleTimer != null) window.clearInterval(entry.idleTimer);
  entry.idleTimer = null;

  streams.delete(opId);
}

/* =============================================================================
 * Hook
 * ============================================================================= */

export function useSqlStreamResult(opId?: string | null): SqlStreamResult {
  const [, force] = useState(0);

  useEffect(() => {
    if (!opId) return;

    ensureSqlStreamStarted(opId);

    const entry = getOrCreate(opId);
    const onChange = () => force((x) => x + 1);

    entry.listeners.add(onChange);
    return () => {
      entry.listeners.delete(onChange);
    };
  }, [opId]);

  const entry = opId ? streams.get(opId) : null;

  const getRowAt = useMemo(() => {
    if (!opId) return () => undefined;
    return (rowIndex: number) => streams.get(opId)?.rowsByIdx.get(rowIndex);
  }, [opId]);

  if (!opId || !entry) {
    return {
      status: "idle",
      columns: [],
      totalRows: 0,
      rowsVersion: 0,
      getRowAt,
    };
  }

  return {
    status: entry.status,
    columns: entry.columns,
    totalRows: entry.totalRows,
    rowsVersion: entry.version,
    error: entry.error,
    getRowAt,
  };
}
