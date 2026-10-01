import { connectionRemove } from "src/lib/tauri";
import { operationCancel } from "src/lib/tauri/operation";
import { tableKey } from "src/hooks/useLoadTableData";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";
import { useUnsavedChangesDialogStore } from "src/stores/unsavedChangesDialog";
import { getConnectionTabCloseBridge } from "./connectionTabCloseBridge";
import { clearConnectionTabChanges, connectionTabHasChanges } from "./tabDirty";

function removeTableDataForTab(
  tabId: string,
  schema: string,
  tableName: string
) {
  const key = tableKey(tabId, schema, tableName);
  const store = useConnectionStore.getState();
  const rowsInfo = store.getRowsWindowInfo(key);
  if (rowsInfo?.opId) {
    operationCancel(rowsInfo.opId).catch(() => {});
  }
  store.clearRows(key);
  store.removeTableDataMap(key);
}

/** Close a connection tab without unsaved-changes checks (internal). */
export async function forceCloseConnectionTab(tabId: string) {
  const {
    profileTabs,
    removeTab,
    activeProfileScreen,
    setActiveProfileScreen,
    openWindows,
  } = useScreenStore.getState();
  const { tableDataMap } = useConnectionStore.getState();

  const currentTab = profileTabs.find((tab) => tab.id === tabId);
  const newTabs = profileTabs.filter((tab) => tab.id !== tabId);

  removeTab(tabId);

  if (activeProfileScreen === tabId) {
    setActiveProfileScreen(
      newTabs.length > 0 ? newTabs[newTabs.length - 1]!.id : "main"
    );
  }

  if (currentTab?.runtimeConnectionId) {
    try {
      await connectionRemove(currentTab.runtimeConnectionId);
    } catch {
      // ignore
    }
  }

  const windows = openWindows[tabId] ?? [];
  if (windows.length === 0) return;

  const tableWindows = windows.filter((w) => w.type === "table");

  await Promise.all(
    tableWindows.map(async (w) => {
      const { schema, name } = w.table;
      const key = tableKey(tabId, schema, name);
      const connId = tableDataMap[key]?.connectionId ?? null;

      removeTableDataForTab(tabId, schema, name);

      if (connId) {
        try {
          await connectionRemove(connId);
        } catch {
          // ignore
        }
      }
    })
  );
}

export async function requestCloseConnectionTab(tabId: string) {
  const registered = getConnectionTabCloseBridge()?.closeTab;
  if (registered) {
    await registered(tabId);
    return;
  }

  if (connectionTabHasChanges(tabId)) {
    useUnsavedChangesDialogStore.getState().openForTabClose(tabId);
    return;
  }

  await forceCloseConnectionTab(tabId);
}

export async function discardPendingTabCloseFromDialog() {
  const bridge = getConnectionTabCloseBridge();
  if (bridge) {
    await bridge.discardChanges();
    return;
  }

  const tabId = useUnsavedChangesDialogStore.getState().pendingCloseTabId;
  if (!tabId) return;

  clearConnectionTabChanges(tabId);
  useUnsavedChangesDialogStore.getState().close();
  await forceCloseConnectionTab(tabId);
}
