import type { PatchMap } from "src/lib/patches/generateSql";
import { useConnectionStore } from "src/stores/connection";
import {
  tabHasPendingObjectWork,
  useObjectDraftStore,
} from "src/stores/objectDrafts";

/** Whether one window's entry of a patch map holds any row change. */
export function patchEntryHasChanges(entry: unknown): boolean {
  const patches = (entry as { patches?: unknown } | undefined)?.patches as
    | Record<string, unknown>
    | undefined;
  if (!patches) return false;

  for (const action of Object.keys(patches)) {
    const actionPatches = patches[action] as
      | Record<string, unknown>
      | undefined;
    if (!actionPatches) continue;

    for (const dataKey of Object.keys(actionPatches)) {
      const rows = actionPatches[dataKey] as
        | Record<string, unknown>
        | undefined;
      if (rows && Object.keys(rows).length > 0) return true;
    }
  }
  return false;
}

function patchMapHasAnyChanges(patchMap: PatchMap | undefined): boolean {
  if (!patchMap) return false;

  const byWin = patchMap as unknown as Record<string, unknown>;
  return Object.keys(byWin).some((winId) => patchEntryHasChanges(byWin[winId]));
}

/** A new-table draft worth keeping: a name and at least one named column. */
export function isValidNewTableDraft(v: unknown): boolean {
  if (!v || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  if (typeof obj.tableName !== "string") return false;
  if (!Array.isArray(obj.columns)) return false;

  const cols = obj.columns as Array<unknown>;
  const hasAnyCol = cols.some((c) => {
    if (!c || typeof c !== "object") return false;
    const cc = c as Record<string, unknown>;
    return (
      typeof cc.column_name === "string" && cc.column_name.trim().length > 0
    );
  });

  return obj.tableName.trim().length > 0 && hasAnyCol;
}

/** Unsaved row changes or a new-table draft of one table window. */
export function tableWindowHasChanges(
  tabId: string,
  windowId: string
): boolean {
  const s = useConnectionStore.getState();
  const pm = s.dataPatchMap[tabId] as unknown as
    | Record<string, unknown>
    | undefined;
  if (patchEntryHasChanges(pm?.[windowId])) return true;
  const nt = s.newTableData[tabId] as unknown as
    | Record<string, unknown>
    | undefined;
  return isValidNewTableDraft(nt?.[windowId]);
}

export function connectionTabHasChanges(tabId: string): boolean {
  // Object drafts live outside the connection store (closed ones too).
  if (tabHasPendingObjectWork(tabId)) return true;

  const s = useConnectionStore.getState();

  const derived = (
    s as unknown as {
      dirtyStateByScreen?: Record<string, { hasAnyChanges: boolean }>;
    }
  ).dirtyStateByScreen?.[tabId]?.hasAnyChanges;

  if (typeof derived === "boolean") return derived;

  const pm = s.dataPatchMap[tabId] as unknown as PatchMap | undefined;
  if (patchMapHasAnyChanges(pm)) return true;

  const nt = s.newTableData[tabId] as unknown as
    | Record<string, unknown>
    | undefined;
  if (!nt) return false;

  for (const winId of Object.keys(nt)) {
    if (isValidNewTableDraft(nt[winId])) return true;
  }
  return false;
}

export function clearConnectionTabChanges(tabId: string) {
  const s = useConnectionStore.getState();
  s.clearTableConstraints(tabId);
  s.clearTableStructure(tabId);
  s.clearDataPatchMap(tabId);
  s.clearNewTableData(tabId);
  useObjectDraftStore.getState().clearTab(tabId);
}
