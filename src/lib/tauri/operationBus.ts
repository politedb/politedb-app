import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type { TableChunk, OperationDone } from "./types";
import { CMD } from "./commands";

type OpId = string;

type OpHandlers = {
  onChunk?: (chunk: TableChunk) => void | Promise<void>;
  onDone?: (done: OperationDone) => void | Promise<void>;
  onError?: (err: any) => void | Promise<void>;
  /**
   * Opt-in serial backpressure for slow consumers (e.g. file export).
   * When true, chunk ACKs wait until onChunk settles, and onDone/onError
   * wait for the per-op write queue to drain. Other consumers omit this.
   */
  awaitChunkHandlers?: boolean;
};

type CachedOp = {
  chunks: TableChunk[];
  done?: OperationDone;
  error?: any;
  createdAt: number;
};

type BusState = {
  inited: boolean;
  initPromise: Promise<void> | null;
  unsubs: UnlistenFn[];
  handlersByOp: Map<OpId, OpHandlers>;
  cacheByOp: Map<OpId, CachedOp>;
  cleanupTimer: ReturnType<typeof setInterval> | null;
  /**
   * Ops whose owner stopped listening for good (invalidate), with when:
   * later events for them are ACKed and dropped, never cached or delivered.
   */
  invalidated: Map<OpId, number>;
};

/* =============================================================================
 * Constants
 * ============================================================================= */

const MAX_CHUNKS_PER_OP = 2000;
const MAX_ROWS_PER_OP = 200_000;
const CACHE_TTL_MS = 60_000; // 1 minute TTL for orphan caches
const CLEANUP_INTERVAL_MS = 15_000;

/* =============================================================================
 * State
 * ============================================================================= */

const state: BusState = {
  inited: false,
  initPromise: null,
  unsubs: [],
  handlersByOp: new Map(),
  cacheByOp: new Map(),
  cleanupTimer: null,
  invalidated: new Map(),
};

/* =============================================================================
 * Helpers
 * ============================================================================= */

function getOpId(payload: unknown): string | null {
  if (payload && typeof payload === "object" && "op_id" in payload) {
    const id = (payload as { op_id: unknown }).op_id;
    return typeof id === "string" && id.length > 0 ? id : null;
  }
  return null;
}

function getOrCreateCache(opId: string): CachedOp {
  let cache = state.cacheByOp.get(opId);
  if (!cache) {
    cache = { chunks: [], createdAt: Date.now() };
    state.cacheByOp.set(opId, cache);
  }
  return cache;
}

function clearCache(opId: string) {
  state.cacheByOp.delete(opId);
}

/**
 * Push chunk to cache. Returns true if accepted, false if dropped due to caps.
 */
function pushChunk(opId: string, chunk: TableChunk): boolean {
  const cache = getOrCreateCache(opId);

  // Cap by chunk count
  if (cache.chunks.length >= MAX_CHUNKS_PER_OP) {
    console.warn(
      `[operationBus] op=${opId} chunk limit warn - MAX_CHUNKS_PER_OP reached`
    );
  }

  // Cap by total row count
  let totalRows = 0;
  for (const c of cache.chunks) {
    totalRows += c.rows?.length ?? 0;
  }
  if (totalRows >= MAX_ROWS_PER_OP) {
    console.warn(
      `[operationBus] op=${opId} row limit warn - MAX_ROWS_PER_OP reached`
    );
  }

  cache.chunks.push(chunk);
  return true;
}

/**
 * Sort chunks by sequence number to ensure correct order.
 */
function getSortedChunks(opId: string): TableChunk[] {
  const cache = state.cacheByOp.get(opId);
  if (!cache?.chunks.length) return [];

  // Sort by seq (ascending)
  return [...cache.chunks].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
}

/**
 * Periodic cleanup of orphan caches (no subscriber, exceeded TTL).
 */
function runCleanup() {
  const now = Date.now();

  for (const [opId, cache] of state.cacheByOp) {
    const hasSubscriber = state.handlersByOp.has(opId);
    const isTerminal = cache.done !== undefined || cache.error !== undefined;
    const isExpired = now - cache.createdAt > CACHE_TTL_MS;

    // Clean if: no subscriber AND (terminal OR expired)
    if (!hasSubscriber && (isTerminal || isExpired)) {
      state.cacheByOp.delete(opId);
    }
  }
  for (const [opId, at] of state.invalidated) {
    if (now - at > CACHE_TTL_MS) state.invalidated.delete(opId);
  }
}

function startCleanupTimer() {
  if (state.cleanupTimer) return;
  state.cleanupTimer = setInterval(runCleanup, CLEANUP_INTERVAL_MS);
}

function stopCleanupTimer() {
  if (state.cleanupTimer) {
    clearInterval(state.cleanupTimer);
    state.cleanupTimer = null;
  }
}

/* =============================================================================
 * FE-ACK Flow Control (batched per animation frame)
 * ============================================================================= */

const pendingAcksByOp = new Map<OpId, number>();
let ackScheduled = false;

function scheduleAckFlush() {
  if (ackScheduled) return;
  ackScheduled = true;

  requestAnimationFrame(async () => {
    ackScheduled = false;

    const entries = Array.from(pendingAcksByOp.entries());
    pendingAcksByOp.clear();

    if (entries.length === 0) return;

    // Batch invoke - could be parallelized but sequential is safer for ordering
    for (const [opId, permits] of entries) {
      try {
        await invoke(CMD.operationChunkAck, {
          input: { op_id: opId, permits },
        });
      } catch {
        // Ignore errors during app shutdown
      }
    }
  });
}

function ackChunk(opId: OpId, count: number = 1) {
  if (count <= 0) return;
  pendingAcksByOp.set(opId, (pendingAcksByOp.get(opId) ?? 0) + count);
  scheduleAckFlush();
}

/* =============================================================================
 * Opt-in serial chunk queue (awaitChunkHandlers)
 * ============================================================================= */

type OpQueue = {
  chain: Promise<void>;
  pending: number;
};

const serialQueueByOp = new Map<OpId, OpQueue>();

function getSerialQueue(opId: OpId): OpQueue {
  let q = serialQueueByOp.get(opId);
  if (!q) {
    q = { chain: Promise.resolve(), pending: 0 };
    serialQueueByOp.set(opId, q);
  }
  return q;
}

function clearSerialQueue(opId: OpId) {
  serialQueueByOp.delete(opId);
}

/**
 * Enqueue work on the per-op serial chain. ACK runs only after onChunk settles
 * when used from the chunk listener path.
 */
function enqueueSerial(
  opId: OpId,
  work: () => void | Promise<void>
): Promise<void> {
  const q = getSerialQueue(opId);
  q.pending += 1;
  const run = q.chain.then(async () => {
    try {
      await work();
    } finally {
      q.pending -= 1;
      if (q.pending <= 0) {
        // Keep map entry until terminal clear so late chunks still serialize.
      }
    }
  });
  // Swallow to keep the chain alive after consumer errors; callers handle errors.
  q.chain = run.catch(() => {});
  return run;
}

async function drainSerialQueue(opId: OpId): Promise<void> {
  const q = serialQueueByOp.get(opId);
  if (!q) return;
  await q.chain;
}

/* =============================================================================
 * Event Listeners
 * ============================================================================= */

async function setupListeners(): Promise<UnlistenFn[]> {
  const uChunk = await listen("op:chunk_table", (e) => {
    const payload = e.payload;
    const opId = getOpId(payload);
    if (!opId) return;

    // Its owner is gone: ACK so the backend is not left waiting on flow
    // control while its cancel takes effect, and drop it.
    if (state.invalidated.has(opId)) {
      ackChunk(opId);
      return;
    }

    const chunk = payload as TableChunk;
    const handlers = state.handlersByOp.get(opId);

    if (handlers?.onChunk) {
      if (handlers.awaitChunkHandlers) {
        // Serial backpressure: ACK only after onChunk settles.
        void enqueueSerial(opId, async () => {
          // Re-check subscription; unsubscribed ops must not ACK late work
          // (an invalidated one is ACKed and dropped, as its later chunks).
          if (state.invalidated.has(opId)) {
            ackChunk(opId);
            return;
          }
          const current = state.handlersByOp.get(opId);
          if (!current?.onChunk) return;
          try {
            await current.onChunk(chunk);
          } finally {
            ackChunk(opId);
          }
        });
      } else {
        // Direct delivery - ACK immediately (existing consumers)
        void handlers.onChunk(chunk);
        ackChunk(opId);
      }
    } else {
      // Cache for later replay - only ACK if accepted
      const accepted = pushChunk(opId, chunk);
      if (accepted) {
        ackChunk(opId);
      }
    }
  });

  const uDone = await listen("op:done", (e) => {
    const payload = e.payload;
    const opId = getOpId(payload);
    if (!opId) return;

    if (state.invalidated.has(opId)) return;

    const done = payload as OperationDone;
    const cache = getOrCreateCache(opId);
    cache.done = done;

    const handlers = state.handlersByOp.get(opId);
    if (handlers?.onDone) {
      if (handlers.awaitChunkHandlers) {
        void (async () => {
          await drainSerialQueue(opId);
          const current = state.handlersByOp.get(opId);
          if (!current?.onDone) return;
          try {
            await current.onDone(done);
          } finally {
            state.handlersByOp.delete(opId);
            clearSerialQueue(opId);
          }
        })();
      } else {
        void handlers.onDone(done);
        state.handlersByOp.delete(opId);
      }
    }
    // Keep cache until subscriber calls unsubscribe or TTL expires
  });

  const uErr = await listen("op:error", (e) => {
    const payload = e.payload;
    const opId = getOpId(payload);
    if (!opId) return;

    if (state.invalidated.has(opId)) return;

    const error = payload as any;
    const cache = getOrCreateCache(opId);
    cache.error = error;

    const handlers = state.handlersByOp.get(opId);
    if (handlers?.onError) {
      if (handlers.awaitChunkHandlers) {
        void (async () => {
          await drainSerialQueue(opId);
          const current = state.handlersByOp.get(opId);
          if (!current?.onError) return;
          try {
            await current.onError(error);
          } finally {
            state.handlersByOp.delete(opId);
            clearSerialQueue(opId);
          }
        })();
      } else {
        void handlers.onError(error);
        state.handlersByOp.delete(opId);
        clearSerialQueue(opId);
      }
    }
  });

  return [uChunk, uDone, uErr];
}

/* =============================================================================
 * Initialization
 * ============================================================================= */

async function initOnce() {
  if (state.inited) return;

  if (state.initPromise) {
    return state.initPromise;
  }

  state.initPromise = (async () => {
    state.unsubs = await setupListeners();
    startCleanupTimer();
    state.inited = true;
  })();

  return state.initPromise;
}

/* =============================================================================
 * Public API
 * ============================================================================= */

export const operationBus = {
  /**
   * Ensure the bus is initialized. Safe to call multiple times.
   */
  async ensureInit(): Promise<void> {
    await initOnce();
  },

  /**
   * Subscribe to operation events. Returns unsubscribe function.
   *
   * - Replays any cached chunks (sorted by seq) before done/error.
   * - Handles race conditions where events arrive before subscription.
   */
  async subscribe(opId: string, handlers: OpHandlers): Promise<() => void> {
    await initOnce();

    if (state.invalidated.has(opId)) return () => {};

    // Register handlers first
    state.handlersByOp.set(opId, handlers);

    const cache = state.cacheByOp.get(opId);

    // Flag to track if unsubscribed (safety for microtask)
    let active = true;

    if (cache) {
      // Replay cached chunks IN ORDER (sorted by seq)
      if (cache.chunks.length > 0 && handlers.onChunk) {
        const sortedChunks = getSortedChunks(opId);

        // Clear cache BEFORE calling handlers to ensure logic order
        cache.chunks = [];

        if (handlers.awaitChunkHandlers) {
          for (const chunk of sortedChunks) {
            if (!active) break;
            void enqueueSerial(opId, async () => {
              if (!active) return;
              const current = state.handlersByOp.get(opId);
              if (!current?.onChunk) return;
              await current.onChunk(chunk);
            });
          }
        } else {
          for (const chunk of sortedChunks) {
            if (!active) break; // Stop if unsubscribed
            void handlers.onChunk(chunk);
          }
        }
      }

      // Replay terminal event (done takes precedence if both exist somehow)
      if (active) {
        if (cache.done && handlers.onDone) {
          if (handlers.awaitChunkHandlers) {
            void (async () => {
              await drainSerialQueue(opId);
              if (active && state.handlersByOp.has(opId)) {
                try {
                  await handlers.onDone?.(cache.done!);
                } finally {
                  state.handlersByOp.delete(opId);
                  clearSerialQueue(opId);
                }
              }
            })();
          } else {
            // Use queueMicrotask to ensure onChunk processing completes first
            queueMicrotask(() => {
              if (active && state.handlersByOp.has(opId)) {
                void handlers.onDone?.(cache.done!);
                state.handlersByOp.delete(opId);
              }
            });
          }
        } else if (cache.error && handlers.onError) {
          if (handlers.awaitChunkHandlers) {
            void (async () => {
              await drainSerialQueue(opId);
              if (active && state.handlersByOp.has(opId)) {
                try {
                  await handlers.onError?.(cache.error!);
                } finally {
                  state.handlersByOp.delete(opId);
                  clearSerialQueue(opId);
                }
              }
            })();
          } else {
            queueMicrotask(() => {
              if (active && state.handlersByOp.has(opId)) {
                void handlers.onError?.(cache.error!);
                state.handlersByOp.delete(opId);
              }
            });
          }
        }
      }
    }

    // Return unsubscribe function
    return () => {
      active = false; // Mark inactive
      state.handlersByOp.delete(opId);
      clearCache(opId);
      clearSerialQueue(opId);
    };
  },

  /**
   * Stops all delivery for an op whose owner has given it up (opt-in; used
   * by dump operations): handlers and cache are dropped now, and later
   * chunks are ACKed and dropped (so the backend is not stalled on flow
   * control while its cancel takes effect), later done/error ignored, and
   * a later subscribe gets nothing. Chunk handlers already running are not
   * interrupted; their owner awaits them.
   */
  invalidate(opId: string): void {
    state.invalidated.set(opId, Date.now());
    state.handlersByOp.delete(opId);
    clearCache(opId);
    clearSerialQueue(opId);
  },

  /**
   * Check if there are pending (undelivered) chunks for an operation.
   */
  hasPendingChunks(opId: string): boolean {
    const cache = state.cacheByOp.get(opId);
    return (cache?.chunks.length ?? 0) > 0;
  },

  /**
   * Get count of pending chunks for an operation.
   */
  getPendingChunkCount(opId: string): number {
    return state.cacheByOp.get(opId)?.chunks.length ?? 0;
  },

  /**
   * Get total pending row count for an operation.
   */
  getPendingRowCount(opId: string): number {
    const cache = state.cacheByOp.get(opId);
    if (!cache) return 0;

    let total = 0;
    for (const chunk of cache.chunks) {
      total += chunk.rows?.length ?? 0;
    }
    return total;
  },

  /**
   * Check if operation has completed (done or error cached).
   */
  isCompleted(opId: string): boolean {
    const cache = state.cacheByOp.get(opId);
    return cache?.done !== undefined || cache?.error !== undefined;
  },

  /**
   * Get cached result if operation completed before subscription.
   */
  getCachedResult(opId: string): { done?: OperationDone; error?: any } | null {
    const cache = state.cacheByOp.get(opId);
    if (!cache) return null;
    if (cache.done === undefined && cache.error === undefined) return null;
    return { done: cache.done, error: cache.error };
  },

  /**
   * Manually clear cache for an operation.
   */
  clearCache(opId: string): void {
    clearCache(opId);
  },

  /**
   * Get diagnostic info for debugging.
   */
  getDebugInfo(): {
    activeOps: string[];
    cachedOps: string[];
    pendingAcks: [string, number][];
  } {
    return {
      activeOps: Array.from(state.handlersByOp.keys()),
      cachedOps: Array.from(state.cacheByOp.keys()),
      pendingAcks: Array.from(pendingAcksByOp.entries()),
    };
  },

  /**
   * Dispose all listeners and clear state. Call on app unmount.
   */
  disposeAll(): void {
    // Stop cleanup timer
    stopCleanupTimer();

    // Unsubscribe all listeners
    for (const unsub of state.unsubs) {
      try {
        unsub();
      } catch {
        // Ignore errors during cleanup
      }
    }

    // Clear all state
    state.unsubs = [];
    state.handlersByOp.clear();
    state.cacheByOp.clear();
    serialQueueByOp.clear();
    pendingAcksByOp.clear();
    ackScheduled = false;
    state.inited = false;
    state.initPromise = null;
  },
};

export type { OpHandlers, TableChunk, OperationDone };
