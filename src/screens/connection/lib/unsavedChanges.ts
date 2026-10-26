import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";
import {
  anyTabHasPendingObjectWork,
  useObjectDraftStore,
} from "src/stores/objectDrafts";
import { draftKeyForWindow, isCreateDraftKey } from "src/lib/objectDraftKey";
import { isValidNewTableDraft, patchEntryHasChanges } from "./tabDirty";

function patchMapHasAnyChanges(patchMap: unknown): boolean {
  if (!patchMap || typeof patchMap !== "object") return false;
  return Object.values(patchMap as Record<string, unknown>).some(
    patchEntryHasChanges
  );
}

export function hasAnyUnsavedConnectionChanges(): boolean {
  const s = useConnectionStore.getState();

  for (const patchMap of Object.values(s.dataPatchMap)) {
    if (patchMapHasAnyChanges(patchMap)) return true;
  }

  for (const tabDrafts of Object.values(s.newTableData)) {
    for (const draft of Object.values(tabDrafts)) {
      if (isValidNewTableDraft(draft)) return true;
    }
  }

  return anyTabHasPendingObjectWork();
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
  // Every object draft goes, closed ones too; create windows close below.
  useObjectDraftStore.getState().clearAll();

  for (const tabId of tabIds) {
    const newTableWindowIds = new Set(Object.keys(s.newTableData[tabId] ?? {}));

    s.clearTableConstraints(tabId);
    s.clearTableStructure(tabId);
    s.clearDataPatchMap(tabId);
    s.clearNewTableData(tabId);

    const windows = screen.openWindows[tabId] ?? [];
    const withoutNewTableWindows = windows.filter((window) => {
      if (window.type === "db-object-manager") {
        return !isCreateDraftKey(draftKeyForWindow(window));
      }
      return (
        window.type !== "table" ||
        (!window.table.new && !newTableWindowIds.has(window.id))
      );
    });
    if (withoutNewTableWindows.length !== windows.length) {
      screen.replaceWindows(tabId, withoutNewTableWindows);
    }
  }
}
