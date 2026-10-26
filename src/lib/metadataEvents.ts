import type { DatabaseObjectItem } from "src/types";

/**
 * Database metadata loads that fetched the complete function/procedure/
 * trigger list, for listeners that reconcile state with it. A load reports
 * its start (synchronously, before any query runs) and, only when the whole
 * load succeeded, its end with the same id. Failed, cancelled and
 * columns-only loads never report an end.
 */
export type ObjectListLoadStart = {
  loadId: number;
  metaKey: string;
  connectionId: string;
};

export type ObjectListLoaded = ObjectListLoadStart & {
  objects: DatabaseObjectItem[];
};

type Listener = {
  onStart?: (event: ObjectListLoadStart) => void;
  onLoaded: (event: ObjectListLoaded) => void;
};

const listeners = new Set<Listener>();
let lastLoadId = 0;

export function onObjectListLoads(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function objectListLoadStarted(args: {
  metaKey: string;
  connectionId: string;
}): number {
  const event = { ...args, loadId: ++lastLoadId };
  listeners.forEach((l) => l.onStart?.(event));
  return event.loadId;
}

export function objectListLoaded(event: ObjectListLoaded) {
  listeners.forEach((l) => l.onLoaded(event));
}
