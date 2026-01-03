import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { OperationDone, TableChunk } from "./types";

/* ============================================================================
 * Events
 * ============================================================================
 */

export function listenOp(
  opId: string,
  onChunk: (chunk: TableChunk) => void,
  onDone: (done: OperationDone) => void,
  onError: (err: any) => void
): UnlistenFn {
  const unsubs: UnlistenFn[] = [];

  Promise.all([
    listen("op:chunk_table", (e) => {
      const p = e.payload as any;
      if (p?.op_id === opId) onChunk(p as TableChunk);
    }),
    listen("op:done", (e) => {
      const p = e.payload as any;
      if (p?.op_id === opId) onDone(p as OperationDone);
    }),
    listen("op:error", (e) => {
      const p = e.payload as any;
      if (p?.op_id === opId) onError(p);
    }),
  ]).then((fns) => unsubs.push(...fns));

  return () => unsubs.forEach((u) => u());
}
