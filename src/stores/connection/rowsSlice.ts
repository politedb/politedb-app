import type { ConnectionState, TableRowState } from "./types";
import {
  DEFAULT_ROWS_CAP,
  cacheGet,
  cachePut,
  clampNonNeg,
  makeRowsState,
  raf,
} from "./rowCache";

type PendingMeta = { loadedMax: number; lastChunkAt: number };

export function createRowsUiActions(args: {
  set: any;
  get: any;
  pendingMeta: Map<string, PendingMeta>;
  scheduleRowsNotify: (key: string, opts?: { immediate?: boolean }) => void;
}): Pick<
  ConnectionState,
  | "initRows"
  | "clearRows"
  | "resetRows"
  | "beginRowsStream"
  | "endRowsStream"
  | "failRowsStream"
  | "setViewport"
  | "shiftWindowToViewport"
  | "applyRowsChunk"
  | "updateRow"
  | "addRow"
  | "removeRow"
  | "getRowAt"
  | "getOriginalRowAt"
  | "getRowsWindowInfo"
  | "setTableFilter"
  | "clearTableFilter"
  | "setSelectedRowDetail"
  | "clearSelectedRowDetail"
  | "registerRowFieldEditHandler"
> {
  const { set, get, pendingMeta, scheduleRowsNotify } = args;
  return {
    initRows: (key, cap) =>
      set((s: ConnectionState) => {
        if (s.tableRowsByKey[key]) return s;
        return {
          tableRowsByKey: {
            ...s.tableRowsByKey,
            [key]: makeRowsState(cap ?? DEFAULT_ROWS_CAP),
          },
        };
      }),
    
    clearRows: (key) =>
      set((s: ConnectionState) => {
        if (!s.tableRowsByKey[key] && !s.tableRowCacheByKey[key]) return s;
    
        const { [key]: _, ...restRows } = s.tableRowsByKey;
        const { [key]: __, ...restCache } = s.tableRowCacheByKey;
    
        return { tableRowsByKey: restRows, tableRowCacheByKey: restCache };
      }),
    
    resetRows: (key) =>
      set((s: ConnectionState) => {
        if (!s.tableRowCacheByKey[key] && !s.tableRowsByKey[key]) return s;
        return {
          tableRowsByKey: {
            ...s.tableRowsByKey,
            [key]: {
              ...s.tableRowsByKey[key],
              rows: Array.from(s.tableRowCacheByKey[key]?.map),
            },
          },
        };
      }),
    
    beginRowsStream: (
      key,
      opId,
      cap,
      streamOffset = 0,
      resetCache = false,
      forceRefresh = false
    ) =>
      set((s: ConnectionState) => {
        // --- UPDATED: Handle cache reset ---
        let currentCache = s.tableRowCacheByKey;
        if (resetCache) {
          const { [key]: _, ...rest } = s.tableRowCacheByKey;
          currentCache = rest;
        }
    
        const prev =
          s.tableRowsByKey[key] ?? makeRowsState(cap ?? DEFAULT_ROWS_CAP);
    
        const nextCap = cap ? Math.max(200, Math.floor(cap)) : prev.cap;
        const nextStreamOffset = clampNonNeg(streamOffset);
    
        // Get cache for this specific key (might be undefined if we just reset it)
        const cacheEntry = currentCache[key];
    
        // Soft refresh window buffer:
        // - Same streamOffset + same cap + !resetCache: keep prev.rows
        // - Otherwise: allocate new window and hydrate from overlap + cache
        let nextRows: (unknown[] | undefined)[];
    
        const sameCap = prev.cap === nextCap;
        const sameStream = prev.streamOffset === nextStreamOffset;
    
        // If resetCache is true, we must assume prev.rows contains stale data (e.g. from previous sort order),
        // so we force a fresh start (no overlap reuse). We still keep prev.rows visible so the UI
        // doesn't flicker to empty during refresh — new chunks will overwrite in place.
        const forceFresh = resetCache;
        const softRefresh = forceRefresh && !resetCache;
    
        if (softRefresh && sameCap && sameStream) {
          // Reload current page: keep visible rows until stream chunks overwrite them.
          nextRows = Array.from(prev.rows);
        } else if (!forceFresh && sameCap && sameStream) {
          nextRows = prev.rows;
        } else if (forceFresh && sameCap && sameStream) {
          // Cache reset (sort/filter): keep previous rows visible until new chunks arrive.
          nextRows = Array.from(prev.rows);
        } else {
          nextRows = new Array(nextCap).fill(undefined);
    
          // Copy overlap: when !forceFresh for normal load; when forceFresh (refresh) keep overlap visible so UI doesn't flicker to empty
          const prevBase = prev.base;
          const prevEnd = prev.base + prev.cap;
          const newBase = nextStreamOffset;
          const newEnd = newBase + nextCap;
          const overlapStart = Math.max(prevBase, newBase);
          const overlapEnd = Math.min(prevEnd, newEnd);
          if (overlapEnd > overlapStart) {
            const len = overlapEnd - overlapStart;
            const srcOff = overlapStart - prevBase;
            const dstOff = overlapStart - newBase;
            for (let i = 0; i < len; i++) {
              nextRows[dstOff + i] = prev.rows[srcOff + i];
            }
          }
    
          // Hydrate from cache for instant render (if cache exists)
          if (!softRefresh && cacheEntry) {
            const newBase = nextStreamOffset;
            for (let i = 0; i < nextCap; i++) {
              if (nextRows[i] !== undefined) continue;
              const globalIdx = newBase + i;
              const cached = cacheGet(cacheEntry, globalIdx);
              if (cached !== undefined) nextRows[i] = cached;
            }
          }
        }
    
        const next: TableRowState = {
          ...prev,
          opId,
    
          cap: nextCap,
          base: nextStreamOffset,
          streamOffset: nextStreamOffset,
    
          rows: nextRows,
    
          // When forceFresh/softRefresh we keep prev.rows visible, so keep loadedMax so UI state stays consistent
          loadedMax:
            forceFresh && sameCap && sameStream
              ? prev.loadedMax
              : softRefresh && sameCap && sameStream
                ? prev.loadedMax
                : forceFresh
                  ? nextStreamOffset - 1
                  : Math.max(prev.loadedMax, nextStreamOffset - 1),
    
          running: true,
          error: null,
          truncated: false,
    
          startedAt: Date.now(),
          lastChunkAt: prev.lastChunkAt,
          version: prev.version,
          receivedAnyChunk: false,
        };
    
        // Schedule 1/frame notify
        raf(() => scheduleRowsNotify(key));
    
        return {
          tableRowsByKey: {
            ...s.tableRowsByKey,
            [key]: next,
          },
          tableRowCacheByKey: currentCache,
        };
      }),
    
    endRowsStream: (key, opId) =>
      set((s: ConnectionState) => {
        const prev = s.tableRowsByKey[key];
        if (!prev || prev.opId !== opId) return s;
    
        const nextRowsByKey = { ...s.tableRowsByKey };
        nextRowsByKey[key] = prev.receivedAnyChunk
          ? { ...prev, running: false }
          : {
              ...prev,
              running: false,
              rows: new Array(prev.cap).fill(undefined),
              loadedMax: prev.streamOffset - 1,
              version: prev.version + 1,
            };
    
        raf(() => scheduleRowsNotify(key));
        return { tableRowsByKey: nextRowsByKey };
      }),
    
    failRowsStream: (key, opId, error) =>
      set((s: ConnectionState) => {
        const prev = s.tableRowsByKey[key];
        if (!prev || prev.opId !== opId) return s;
    
        const nextRowsByKey = { ...s.tableRowsByKey };
        nextRowsByKey[key] = { ...prev, running: false, error };
    
        raf(() => scheduleRowsNotify(key));
        return { tableRowsByKey: nextRowsByKey };
      }),
    
    // IMPORTANT: no rerender on scroll
    setViewport: (key, start, end) =>
      set((s: ConnectionState) => {
        const prev = s.tableRowsByKey[key];
        if (!prev) return s;
    
        const vs = clampNonNeg(start);
        const ve = clampNonNeg(end);
    
        if (prev.viewportStart === vs && prev.viewportEnd === ve) return s;
    
        prev.viewportStart = vs;
        prev.viewportEnd = ve;
        return s;
      }),
    
    shiftWindowToViewport: (key) =>
      set((s: ConnectionState) => {
        const prev = s.tableRowsByKey[key];
        if (!prev) return s;
    
        const overscan = Math.min(1500, Math.floor(prev.cap * 0.4));
        const desiredBase = Math.max(0, prev.viewportStart - overscan);
    
        const curStart = prev.base;
        const curEnd = prev.base + prev.cap;
    
        const stillOk =
          prev.viewportStart >= curStart + Math.floor(overscan * 0.3) &&
          prev.viewportEnd <= curEnd - Math.floor(overscan * 0.3);
    
        if (stillOk) return s;
    
        const nextRows = new Array(prev.cap).fill(undefined);
    
        const overlapStart = Math.max(curStart, desiredBase);
        const overlapEnd = Math.min(curEnd, desiredBase + prev.cap);
    
        if (overlapEnd > overlapStart) {
          const len = overlapEnd - overlapStart;
          const srcOff = overlapStart - curStart;
          const dstOff = overlapStart - desiredBase;
          for (let i = 0; i < len; i++) {
            nextRows[dstOff + i] = prev.rows[srcOff + i];
          }
        }
    
        const cache = s.tableRowCacheByKey[key];
        if (cache) {
          for (let i = 0; i < prev.cap; i++) {
            if (nextRows[i] !== undefined) continue;
            const rowIndex = desiredBase + i;
            const cached = cacheGet(cache, rowIndex);
            if (cached !== undefined) nextRows[i] = cached;
          }
        }
    
        const nextRowsByKey = { ...s.tableRowsByKey };
        nextRowsByKey[key] = {
          ...prev,
          base: desiredBase,
          rows: nextRows,
          version: prev.version,
        };
    
        raf(() => scheduleRowsNotify(key));
        return { tableRowsByKey: nextRowsByKey };
      }),
    
    applyRowsChunk: (key, opId, chunk) =>
      set((s: ConnectionState) => {
        const prev = s.tableRowsByKey[key];
        if (!prev || prev.opId !== opId) return s;
    
        const incoming = (chunk?.rows ?? []) as unknown[][];
        if (!incoming.length) return s;
    
        const localOff = clampNonNeg(chunk?.row_offset ?? 0);
    
        const base = prev.base;
        const end = base + prev.cap;
        const streamOffset = prev.streamOffset;
    
        let cache = s.tableRowCacheByKey[key];
        let cacheChanged = false;
    
        if (!cache) {
          cache = { map: new Map<number, unknown[]>(), order: [] };
          cacheChanged = true;
        }
    
        const lastChunkAt = Date.now();
        let loadedMax = prev.loadedMax;
        prev.receivedAnyChunk = true;
    
        let touched = 0;
    
        for (let i = 0; i < incoming.length; i++) {
          const globalRowIndex = streamOffset + localOff + i;
          const row = incoming[i]!;
          if (globalRowIndex > loadedMax) loadedMax = globalRowIndex;
    
          cachePut(cache, globalRowIndex, row);
    
          if (globalRowIndex < base || globalRowIndex >= end) continue;
          prev.rows[globalRowIndex - base] = row;
          touched++;
        }
    
        const prevMeta = pendingMeta.get(key);
        if (!prevMeta) {
          pendingMeta.set(key, { loadedMax, lastChunkAt });
        } else {
          prevMeta.loadedMax = Math.max(prevMeta.loadedMax, loadedMax);
          prevMeta.lastChunkAt = lastChunkAt;
        }
    
        const wasEmpty = prev.loadedMax < prev.streamOffset; // no rows loaded yet
        const nowHasAny = loadedMax >= prev.streamOffset;
    
        if (
          (wasEmpty && nowHasAny) ||
          touched > 0 ||
          loadedMax > prev.loadedMax
        ) {
          scheduleRowsNotify(key, { immediate: wasEmpty && nowHasAny });
        }
    
        if (cacheChanged) {
          return {
            tableRowCacheByKey: {
              ...s.tableRowCacheByKey,
              [key]: cache,
            },
          };
        }
    
        return s;
      }),
    
    updateRow: (key, rowIndex, row) =>
      set((s: ConnectionState) => {
        const prev = s.tableRowsByKey[key];
        if (!prev) return s;
    
        const idx = clampNonNeg(rowIndex);
        const base = prev.base;
        const cap = prev.cap;
    
        // Check if row is within current window
        if (idx < base || idx >= base + cap) return s;
    
        // Update the row in the window
        const windowIndex = idx - base;
        const newRows = [...prev.rows];
        newRows[windowIndex] = row;
    
        return {
          tableRowsByKey: {
            ...s.tableRowsByKey,
            [key]: { ...prev, rows: newRows },
          },
        };
      }),
    
    addRow: (key, row) =>
      set((s: ConnectionState) => {
        const prev = s.tableRowsByKey[key];
        if (!prev) return s;
    
        const newGlobalIndex = prev.loadedMax + 1;
    
        // --- update window if visible ---
        let rows = prev.rows;
        if (
          newGlobalIndex >= prev.base &&
          newGlobalIndex < prev.base + prev.cap
        ) {
          const localIndex = newGlobalIndex - prev.base;
          rows = [...prev.rows];
          rows[localIndex] = row;
        }
    
        const next = {
          ...prev,
          rows,
          loadedMax: newGlobalIndex,
          version: prev.version + 1, // 🔥 important
        };
    
        return {
          tableRowsByKey: {
            ...s.tableRowsByKey,
            [key]: next,
          },
        };
      }),
    
    removeRow: (key, globalRowIndex) =>
      set((s: ConnectionState) => {
        const prev = s.tableRowsByKey[key];
        if (!prev) return s;
        // Only support removing the last added row (unsaved new row)
        if (
          globalRowIndex !== prev.loadedMax ||
          prev.loadedMax < prev.streamOffset
        )
          return s;
    
        const nextLoadedMax = prev.loadedMax - 1;
        let rows = prev.rows;
        if (
          globalRowIndex >= prev.base &&
          globalRowIndex < prev.base + prev.cap
        ) {
          const localIndex = globalRowIndex - prev.base;
          rows = [...prev.rows];
          rows[localIndex] = undefined;
        }
    
        const next = {
          ...prev,
          rows,
          loadedMax: nextLoadedMax,
          version: prev.version + 1,
        };
    
        return {
          tableRowsByKey: {
            ...s.tableRowsByKey,
            [key]: next,
          },
        };
      }),
    
    getRowAt: (key, rowIndex) => {
      const st = get().tableRowsByKey[key];
      if (!st) return undefined;
    
      const idx = clampNonNeg(rowIndex);
    
      if (idx >= st.base && idx < st.base + st.cap) {
        const v = st.rows[idx - st.base];
        if (v !== undefined) return v as any;
      }
    
      const cache = get().tableRowCacheByKey[key];
      return cacheGet(cache, idx) as any;
    },
    
    getOriginalRowAt: (key, rowIndex) => {
      const idx = clampNonNeg(rowIndex);
      const cache = get().tableRowCacheByKey[key];
      const cached = cacheGet(cache, idx);
      if (cached !== undefined) return cached as unknown[];
    
      return get().getRowAt(key, rowIndex);
    },
    
    getRowsWindowInfo: (key) => {
      const st = get().tableRowsByKey[key];
      return st ?? null;
    },
    
    setTableFilter: (key, filter) =>
      set((s: ConnectionState) => ({
        tableFilterByKey: { ...s.tableFilterByKey, [key]: filter },
      })),
    
    clearTableFilter: (key, visible = true) =>
      set((s: ConnectionState) => ({
        tableFilterByKey: {
          ...s.tableFilterByKey,
          [key]: {
            ...s.tableFilterByKey[key],
            appliedFilters: [],
            appliedFilterCombine: "AND",
            filterBarVisible: visible,
          },
        },
      })),
    
    setSelectedRowDetail: (key, detail) =>
      set((s: ConnectionState) => {
        const prev = s.selectedRowByKey[key] ?? null;
        if (prev === detail) return s;
        if (
          prev &&
          detail &&
          prev.rowIndex === detail.rowIndex &&
          prev.fields.length === detail.fields.length &&
          prev.fields.every(
            (f, i) =>
              f.name === detail.fields[i]?.name &&
              f.value === detail.fields[i]?.value &&
              f.dataType === detail.fields[i]?.dataType &&
              f.isNull === detail.fields[i]?.isNull &&
              f.readonly === detail.fields[i]?.readonly
          )
        ) {
          return s;
        }
        return {
          selectedRowByKey: { ...s.selectedRowByKey, [key]: detail },
        };
      }),
    
    clearSelectedRowDetail: (key) =>
      set((s: ConnectionState) => {
        if (!(key in s.selectedRowByKey)) return s;
        const next = { ...s.selectedRowByKey };
        delete next[key];
        return { selectedRowByKey: next };
      }),
    
    registerRowFieldEditHandler: (key, handler) =>
      set((s: ConnectionState) => {
        const prev = s.rowFieldEditHandlerByKey[key];
        if (prev === handler) return s;
        const next = { ...s.rowFieldEditHandlerByKey };
        if (handler) next[key] = handler;
        else delete next[key];
        return { rowFieldEditHandlerByKey: next };
      }),
  };
}
