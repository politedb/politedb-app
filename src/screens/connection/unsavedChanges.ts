import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";

function patchMapHasAnyChanges(patchMap: unknown): boolean {
  if (!patchMap || typeof patchMap !== "object") return false;

  for (const entry of Object.values(patchMap as Record<string, unknown>)) {
    const patches = (entry as { patches?: unknown } | undefined)?.patches;
    if (!patches || typeof patches !== "object") continue;

    for (const actionPatches of Object.values(
      patches as Record<string, unknown>
    )) {
      if (!actionPatches || typeof actionPatches !== "object") continue;

      for (const rows of Object.values(
        actionPatches as Record<string, unknown>
      )) {
        if (rows && typeof rows === "object" && Object.keys(rows).length > 0) {
          return true;
        }
      }
    }
  }

  return false;
}

function hasValidNewTableDraft(draft: unknown): boolean {
  if (!draft || typeof draft !== "object") return false;
  const data = draft as {
    tableName?: unknown;
    columns?: Array<{ column_name?: unknown }>;
  };

  return (
    typeof data.tableName === "string" &&
    data.tableName.trim().length > 0 &&
    Array.isArray(data.columns) &&
    data.columns.some(
      (column) =>
        typeof column?.column_name === "string" &&
        column.column_name.trim().length > 0
    )
  );
}

export function hasAnyUnsavedConnectionChanges(): boolean {
  const s = useConnectionStore.getState();

  for (const patchMap of Object.values(s.dataPatchMap)) {
    if (patchMapHasAnyChanges(patchMap)) return true;
  }

  for (const tabDrafts of Object.values(s.newTableData)) {
    for (const draft of Object.values(tabDrafts)) {
      if (hasValidNewTableDraft(draft)) return true;
    }
  }

  return false;
}

export function discardAllConnectionChanges() {
  const s = useConnectionStore.getState();
  const screen = useScreenStore.getState();
  const tabIds = new Set<string>([
    ...Object.keys(s.dataPatchMap),
    ...Object.keys(s.newTableData),
    ...Object.keys(s.tableStructure),
    ...Object.keys(s.tableConstraints),
    ...Object.keys(screen.openWindows),
  ]);

  for (const tabId of tabIds) {
    const newTableWindowIds = new Set(Object.keys(s.newTableData[tabId] ?? {}));

    s.clearTableConstraints(tabId);
    s.clearTableStructure(tabId);
    s.clearDataPatchMap(tabId);
    s.clearNewTableData(tabId);

    const windows = screen.openWindows[tabId] ?? [];
    const withoutNewTableWindows = windows.filter(
      (window) =>
        window.type !== "table" ||
        (!window.table.new && !newTableWindowIds.has(window.id))
    );
    if (withoutNewTableWindows.length !== windows.length) {
      screen.replaceWindows(tabId, withoutNewTableWindows);
    }
  }
}
