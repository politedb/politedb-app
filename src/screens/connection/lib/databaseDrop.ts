import {
  currentDatabaseFromInput,
  inferDatabaseOverrideFromTabLabel,
} from "src/lib/connection/connection";
import { tabSafetyModeNow } from "src/lib/dump/dumpRestoreSafety";
import { readNeedsTouchId } from "src/lib/queries/querySafety";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";
import { useProfileStore } from "src/stores/profile";
import { useScreenStore } from "src/stores/screen";
import type { DatabaseChange } from "src/hooks/useDatabases";
import type { DatabaseEngine } from "src/types";
import { requestCloseConnectionTab } from "./connectionTabClose";
import { connectionTabHasChanges } from "./tabDirty";

/** The database a connection tab is using. */
export function tabDatabase(tabId: string): string {
  const tab = useScreenStore
    .getState()
    .profileTabs.find((item) => item.id === tabId);
  if (!tab) return "";
  const profile = useProfileStore.getState().getProfileById(tab.profileId);
  return (
    tab.databaseOverride ||
    inferDatabaseOverrideFromTabLabel(profile?.label, tab.label) ||
    currentDatabaseFromInput(profile?.engine, profile?.input)
  );
}

/** Open tabs of a saved connection that are using a database. */
export function tabsOnDatabase(profileId: string, database: string): string[] {
  return useScreenStore
    .getState()
    .profileTabs.filter(
      (tab) => tab.profileId === profileId && tabDatabase(tab.id) === database
    )
    .map((tab) => tab.id);
}

/**
 * Engines that refuse to drop the database the dropping session is in
 * (PostgreSQL: "cannot drop the currently open database"; SQL Server: "in
 * use").
 */
function dropNeedsAnotherDatabase(engine?: DatabaseEngine): boolean {
  return engine === "postgres" || engine === "sqlserver";
}

/** Why the mode refuses database changes, or null (Safe and Default). */
function modeRefusal(mode: ReturnType<typeof tabSafetyModeNow>) {
  if (mode === null) return "The connection tab was closed.";
  if (mode === "lock") {
    return "This tab is locked. Unlock it to change databases.";
  }
  if (mode === "production") {
    return "Production mode blocks changes to the database. Choose another safety mode to change databases.";
  }
  return null;
}

/** Why the tab cannot drop this database itself, or null. */
export function dropFromOwnDatabase(
  tabId: string,
  engine: DatabaseEngine | undefined,
  database: string
): string | null {
  if (!dropNeedsAnotherDatabase(engine)) return null;
  if (tabDatabase(tabId) !== database) return null;
  return `This tab is connected to "${database}", and a database cannot be dropped while connected to it. Open another database on this connection (for example ${engine === "sqlserver" ? "master" : "postgres"}) and drop "${database}" from there.`;
}

/** The connection's other tabs using the database. */
function otherTabsOnDatabase(
  profileId: string,
  database: string,
  keepTabId: string
): string[] {
  return tabsOnDatabase(profileId, database).filter((id) => id !== keepTabId);
}

/**
 * The check before a database change from a tab. Lock and Production
 * refuse it, Safe asks for Touch ID (once). A drop also refuses the tab's
 * own database and closes the connection's other tabs using it.
 *
 * Closing tabs and Touch ID wait, and the tab may be switched to another
 * mode, closed or reconnected meanwhile, or a tab opened on the database:
 * everything is checked again after the last wait, so the SQL is sent
 * right after a passing check.
 */
export async function beforeDatabaseChange(
  tabId: string,
  profileId: string,
  engine: DatabaseEngine | undefined,
  change: DatabaseChange,
  /** The connection the SQL will run on: the tab must still use it. */
  runtimeConnectionId?: string
): Promise<string | null> {
  let authenticated = false;

  /** The live mode allows the change; asks for Touch ID when Safe. */
  const modeAllows = async (): Promise<string | null> => {
    for (;;) {
      const mode = tabSafetyModeNow(tabId);
      const refusal = modeRefusal(mode);
      if (refusal) return refusal;
      if (authenticated || !readNeedsTouchId(mode!)) return null;
      try {
        await securityTouchIdAuthenticate(
          "Authenticate with Touch ID to change databases on this connection."
        );
      } catch {
        return "Touch ID was not confirmed, so nothing was changed.";
      }
      authenticated = true;
      // Read the mode again: it may have changed during Touch ID.
    }
  };

  /** Checks with nothing awaited, run last. */
  const stillValid = (): string | null => {
    const tab = useScreenStore
      .getState()
      .profileTabs.find((item) => item.id === tabId);
    if (!tab) return "The connection tab was closed.";
    if (
      runtimeConnectionId &&
      tab.runtimeConnectionId !== runtimeConnectionId
    ) {
      return "The connection tab reconnected meanwhile, so nothing was changed. Try again.";
    }
    if (change.kind !== "drop") return null;
    const own = dropFromOwnDatabase(tabId, engine, change.name);
    if (own) return own;
    const remaining = otherTabsOnDatabase(profileId, change.name, tabId);
    if (remaining.length === 0) return null;
    return remaining.some((id) => connectionTabHasChanges(id))
      ? `A tab using "${change.name}" has unsaved changes. Save or discard them, then drop the database.`
      : `A tab using "${change.name}" is still open. Close it, then drop the database.`;
  };

  if (change.kind === "drop") {
    const own = dropFromOwnDatabase(tabId, engine, change.name);
    if (own) return own;
  }
  const refused = await modeAllows();
  if (refused) return refused;

  if (change.kind === "drop") {
    for (const id of otherTabsOnDatabase(profileId, change.name, tabId)) {
      await requestCloseConnectionTab(id);
    }
    // The mode may have changed while tabs were closing.
    const after = await modeAllows();
    if (after) return after;
  }
  return stillValid();
}

/** A clearer message for a failed DROP DATABASE. */
export function describeDropError(message: string, database: string): string {
  if (/being accessed by other users|currently in use/i.test(message)) {
    return `Other sessions are still connected to "${database}" (another app, or another saved connection to this server). Close them and try again.\n\n${message}`;
  }
  return message;
}
