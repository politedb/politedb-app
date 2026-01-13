import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { TableChunk, OperationDone } from "./types";

type OpId = string;

type OpHandlers = {
  onChunk?: (chunk: TableChunk) => void;
  onDone?: (done: OperationDone) => void;
  onError?: (err: any) => void;
};

type BusState = {
  inited: boolean;
  unsubs: UnlistenFn[];
  handlersByOp: Map<OpId, OpHandlers>;

  // ✅ caches to avoid missing early terminal events
  doneByOp: Map<OpId, OperationDone>;
  errByOp: Map<OpId, any>;

  // ✅ cache chunks to avoid missing early chunks
  chunksByOp: Map<OpId, TableChunk[]>;
};

const state: BusState = {
  inited: false,
  unsubs: [],
  handlersByOp: new Map(),

  doneByOp: new Map(),
  errByOp: new Map(),

  chunksByOp: new Map(),
};

function getOpId(payload: any): string | null {
  const id = payload?.op_id;
  return typeof id === "string" && id.length ? id : null;
}

const MAX_CHUNKS_PER_OP = 2000; // safety cap
const MAX_ROWS_PER_OP = 200_000; // safety cap (if each chunk has many rows)

function pushChunk(opId: string, chunk: TableChunk) {
  let list = state.chunksByOp.get(opId);
  if (!list) {
    list = [];
    state.chunksByOp.set(opId, list);
  }

  // Basic cap by chunk count
  if (list.length >= MAX_CHUNKS_PER_OP) return;

  // Optional cap by row count (approx)
  let rowTotal = 0;
  for (const c of list) rowTotal += c.rows?.length ?? 0;
  if (rowTotal >= MAX_ROWS_PER_OP) return;

  list.push(chunk);
}

function clearCaches(opId: string) {
  state.doneByOp.delete(opId);
  state.errByOp.delete(opId);
  state.chunksByOp.delete(opId);
}

async function initOnce() {
  if (state.inited) return;
  state.inited = true;

  const uChunk = await listen("op:chunk_table", (e) => {
    const p: any = e.payload;
    const opId = getOpId(p);
    if (!opId) return;

    const chunk = p as TableChunk;
    const h = state.handlersByOp.get(opId);

    if (h?.onChunk) {
      h.onChunk(chunk);
    } else {
      // ✅ cache early chunks until someone subscribes
      pushChunk(opId, chunk);
    }
  });

  const uDone = await listen("op:done", (e) => {
    const p: any = e.payload;
    const opId = getOpId(p);
    if (!opId) return;

    const done = p as OperationDone;

    // cache terminal
    state.doneByOp.set(opId, done);

    // dispatch
    const h = state.handlersByOp.get(opId);
    h?.onDone?.(done);

    // cleanup handlers after terminal event
    state.handlersByOp.delete(opId);
    // keep caches until subscriber calls unsubscribe, OR clear here if you want:
    // clearCaches(opId);
  });

  const uErr = await listen("op:error", (e) => {
    const p: any = e.payload;
    const opId = getOpId(p);
    if (!opId) return;

    state.errByOp.set(opId, p);

    const h = state.handlersByOp.get(opId);
    h?.onError?.(p);

    state.handlersByOp.delete(opId);
    // clearCaches(opId);
  });

  state.unsubs.push(uChunk, uDone, uErr);
}

export const operationBus = {
  async ensureInit() {
    await initOnce();
  },

  async subscribe(opId: string, handlers: OpHandlers): Promise<() => void> {
    await initOnce();

    // set handlers first
    state.handlersByOp.set(opId, handlers);

    // ✅ replay cached chunks (if any) IN ORDER
    const chunks = state.chunksByOp.get(opId);
    if (chunks?.length) {
      for (const c of chunks) handlers.onChunk?.(c);
      state.chunksByOp.delete(opId);
    }

    // ✅ replay cached done/error if they arrived early
    const done = state.doneByOp.get(opId);
    if (done) {
      handlers.onDone?.(done);
      state.handlersByOp.delete(opId);
      // clearCaches(opId); // optional
    }

    const err = state.errByOp.get(opId);
    if (err) {
      handlers.onError?.(err);
      state.handlersByOp.delete(opId);
      // clearCaches(opId); // optional
    }

    return () => {
      state.handlersByOp.delete(opId);
      clearCaches(opId);
    };
  },

  disposeAll() {
    for (const u of state.unsubs) {
      try {
        u();
      } catch {}
    }
    state.unsubs = [];
    state.handlersByOp.clear();

    state.doneByOp.clear();
    state.errByOp.clear();
    state.chunksByOp.clear();

    state.inited = false;
  },
};
