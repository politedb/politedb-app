import type { PatchMap } from "src/utils/generateSql";
import { useConnectionStore } from "src/stores/connection";

function patchMapHasAnyChanges(patchMap: PatchMap | undefined): boolean {
  if (!patchMap) return false;

  const byWin = patchMap as unknown as Record<string, unknown>;
  for (const winId of Object.keys(byWin)) {
    const win = byWin[winId] as { patches?: unknown } | undefined;
    const patches = win?.patches as Record<string, unknown> | undefined;
    if (!patches) continue;

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
  }

  return false;
}

function isValidNewTableDraft(v: unknown): boolean {
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

export function connectionTabHasChanges(tabId: string): boolean {
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
}
