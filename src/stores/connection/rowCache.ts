import type { TableConstraint } from "src/types";
import type { TableRowCache, TableRowState } from "./types";

const ROW_CACHE_LIMIT = 100000;
const ROW_CACHE_EVICT_BATCH = 512;

export function cachePut(cache: TableRowCache, idx: number, row: unknown[]) {
  if (!cache.map.has(idx)) cache.order.push(idx);
  cache.map.set(idx, row);

  if (
    cache.order.length - cache.orderHead >
    ROW_CACHE_LIMIT + ROW_CACHE_EVICT_BATCH
  ) {
    for (let i = 0; i < ROW_CACHE_EVICT_BATCH; i++) {
      const oldest = cache.order[cache.orderHead++];
      if (oldest === undefined) break;
      cache.map.delete(oldest);
    }

    if (
      cache.orderHead >= ROW_CACHE_EVICT_BATCH * 8 &&
      cache.orderHead * 2 >= cache.order.length
    ) {
      cache.order = cache.order.slice(cache.orderHead);
      cache.orderHead = 0;
    }
  }
}

export function cacheGet(cache: TableRowCache | undefined, idx: number) {
  if (!cache) return undefined;
  return cache.map.get(idx);
}

export function normalizePrimaryKeyValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").trim())
      .filter(Boolean)
      .sort();
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean)
      .sort();
  }

  return [];
}

export function getPrimaryKeyColumnsFromConstraints(
  constraints: TableConstraint[] | null | undefined
): string[] {
  if (!constraints?.length) return [];

  const isTruthy = (v: unknown) =>
    v === true || String(v ?? "").toLowerCase() === "true";

  const pkConstraint = constraints.find(
    (c) =>
      isTruthy(c.is_primary) ||
      c.index_name?.toLowerCase() === "primary" ||
      c.index_name?.toLowerCase().includes("pkey") ||
      (isTruthy(c.is_unique) && c.index_name?.toLowerCase().includes("primary"))
  );

  return normalizePrimaryKeyValue(pkConstraint?.column_name);
}

export function raf(cb: () => void) {
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(cb);
  else setTimeout(cb, 16);
}

export const DEFAULT_ROWS_CAP = 1000;

export function clampNonNeg(n: number) {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

export function makeRowsState(cap: number): TableRowState {
  const c = Math.max(200, Math.floor(cap || DEFAULT_ROWS_CAP));
  return {
    opId: undefined,
    base: 0,
    cap: c,
    rows: new Array(c).fill(undefined),

    streamOffset: 0,

    viewportStart: 0,
    viewportEnd: 0,

    loadedMax: -1,
    running: false,
    error: null,
    truncated: false,

    version: 0,
    receivedAnyChunk: false,
  };
}
