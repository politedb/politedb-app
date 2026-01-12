import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { TableChunk, OperationDone } from "./types";

type OpId = string;

type OpHandlers = {
  onMeta?: (meta: any) => void;
  onChunk?: (chunk: TableChunk) => void;
  onDone?: (done: OperationDone) => void;
  onError?: (err: any) => void;
};

type BusState = {
  inited: boolean;
  unsubs: UnlistenFn[];
  handlersByOp: Map<OpId, OpHandlers>;

  // ✅ caches to avoid missing early events
  metaByOp: Map<OpId, any>;
  doneByOp: Map<OpId, OperationDone>;
  errByOp: Map<OpId, any>;
};

const state: BusState = {
  inited: false,
  unsubs: [],
  handlersByOp: new Map(),

  metaByOp: new Map(),
  doneByOp: new Map(),
  errByOp: new Map(),
};

function getOpId(payload: any): string | null {
  const id = payload?.op_id;
  return typeof id === "string" && id.length ? id : null;
}

function normalizeMetaPayload(payload: any) {
  return payload?.columns ?? payload?.meta?.columns ?? payload?.meta ?? payload;
}

async function initOnce() {
  if (state.inited) return;
  state.inited = true;

  const uChunk = await listen("op:chunk_table", (e) => {
    const p: any = e.payload;
    const opId = getOpId(p);
    if (!opId) return;

    const h = state.handlersByOp.get(opId);
    h?.onChunk?.(p as TableChunk);
  });

  const uMeta = await listen("op:meta", (e) => {
    const p: any = e.payload;
    const opId = getOpId(p);
    if (!opId) return;

    const meta = normalizeMetaPayload(p);
    state.metaByOp.set(opId, meta);

    const h = state.handlersByOp.get(opId);
    h?.onMeta?.(meta);
  });

  const uDone = await listen("op:done", (e) => {
    const p: any = e.payload;
    const opId = getOpId(p);
    if (!opId) return;

    state.doneByOp.set(opId, p as OperationDone);

    const h = state.handlersByOp.get(opId);
    h?.onDone?.(p as OperationDone);

    // cleanup handlers after terminal event
    state.handlersByOp.delete(opId);
    // keep meta/done cached for a short while (or clear immediately if you prefer)
  });

  const uErr = await listen("op:error", (e) => {
    const p: any = e.payload;
    const opId = getOpId(p);
    if (!opId) return;

    state.errByOp.set(opId, p);

    const h = state.handlersByOp.get(opId);
    h?.onError?.(p);

    state.handlersByOp.delete(opId);
  });

  state.unsubs.push(uChunk, uMeta, uDone, uErr);
}

function clearCaches(opId: string) {
  state.metaByOp.delete(opId);
  state.doneByOp.delete(opId);
  state.errByOp.delete(opId);
}

export const operationBus = {
  async ensureInit() {
    await initOnce();
  },

  async subscribe(opId: string, handlers: OpHandlers): Promise<() => void> {
    await initOnce();

    // set handlers
    state.handlersByOp.set(opId, handlers);

    // ✅ replay cached meta/done/error if they arrived early
    const meta = state.metaByOp.get(opId);
    if (meta !== undefined) handlers.onMeta?.(meta);

    const done = state.doneByOp.get(opId);
    if (done) {
      handlers.onDone?.(done);
      state.handlersByOp.delete(opId);
    }

    const err = state.errByOp.get(opId);
    if (err) {
      handlers.onError?.(err);
      state.handlersByOp.delete(opId);
    }

    return () => {
      state.handlersByOp.delete(opId);
      clearCaches(opId); // ✅ avoid leaks
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

    state.metaByOp.clear();
    state.doneByOp.clear();
    state.errByOp.clear();

    state.inited = false;
  },
};
