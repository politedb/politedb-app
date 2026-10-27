import type { ConnectionProfile } from "src/lib/tauri";
import { confirmDialog, showMessage } from "src/lib/system-dialog";
import { requestCloseConnectionTab } from "src/screens/connection/lib/connectionTabClose";
import { connectionTabHasChanges } from "src/screens/connection/lib/tabDirty";
import { useScreenStore } from "src/stores/screen";

/**
 * Deletes a saved connection after asking. Its open tabs are closed first
 * (a tab cannot outlive its profile: switching database or reconnecting
 * needs it); while one of them holds unsaved work nothing is deleted, so
 * that work is never dropped silently. Returns whether it was deleted.
 */
export async function deleteConnectionProfile(
  profile: ConnectionProfile,
  removeProfile: (profileId: string) => Promise<void>
): Promise<boolean> {
  const name = profile.label || "Unnamed";
  const tabsOf = () =>
    useScreenStore
      .getState()
      .profileTabs.filter((tab) => tab.profileId === profile.id);

  if (tabsOf().some((tab) => connectionTabHasChanges(tab.id))) {
    await showMessage(
      `"${name}" is open in a tab with unsaved changes. Save or discard them, then delete the connection.`,
      { title: "Delete connection", kind: "warning" }
    );
    return false;
  }

  const openCount = tabsOf().length;
  const tabsNote =
    openCount === 0
      ? ""
      : openCount === 1
        ? " Its open tab will be closed."
        : ` Its ${openCount} open tabs will be closed.`;
  const ok = await confirmDialog(
    `Delete "${name}"? This removes the saved connection and cannot be undone.${tabsNote}`,
    {
      title: "Delete connection",
      kind: "warning",
      okLabel: "Delete",
      cancelLabel: "Cancel",
    }
  );
  if (!ok) return false;

  for (const tab of tabsOf()) {
    await requestCloseConnectionTab(tab.id);
  }
  // Changes made while the question was open keep their tab: stop there.
  if (tabsOf().length > 0) return false;

  await removeProfile(profile.id);
  return true;
}
