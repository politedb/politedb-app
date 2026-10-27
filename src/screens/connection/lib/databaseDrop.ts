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

/**
 * Why a database cannot be changed (created, renamed or dropped) from a
 * tab right now, or null. Lock and Production refuse it; Safe asks for
 * Touch ID.
 */
export async function databaseChangeBlocked(
  tabId: string
): Promise<string | null> {
  const mode = tabSafetyModeNow(tabId);
  if (mode === null) return "The connection tab was closed.";
  if (mode === "lock")
    return "This tab is locked. Unlock it to change databases.";
  if (mode === "production") {
    return "Production mode blocks changes to the database. Choose another safety mode to change databases.";
  }
  if (readNeedsTouchId(mode)) {
    try {
      await securityTouchIdAuthenticate(
        "Authenticate with Touch ID to change databases on this connection."
      );
    } catch {
      return "Touch ID was not confirmed, so nothing was changed.";
    }
    // The mode may have changed while Touch ID was open.
    const after = tabSafetyModeNow(tabId);
    if (after !== mode) return databaseChangeBlocked(tabId);
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

/**
 * Closes the other tabs using the database. False when one of them stayed
 * open (unsaved changes): nothing is dropped then.
 */
export async function closeTabsOnDatabase(
  profileId: string,
  database: string,
  keepTabId: string
): Promise<boolean> {
  const others = () =>
    tabsOnDatabase(profileId, database).filter((id) => id !== keepTabId);
  for (const id of others()) {
    await requestCloseConnectionTab(id);
  }
  return others().length === 0;
}

/**
 * The check before a database change from a tab: the safety mode, and for
 * a drop, the tab's own database and the other tabs using it (closed here).
 */
export async function beforeDatabaseChange(
  tabId: string,
  profileId: string,
  engine: DatabaseEngine | undefined,
  change: DatabaseChange
): Promise<string | null> {
  if (change.kind === "drop") {
    const own = dropFromOwnDatabase(tabId, engine, change.name);
    if (own) return own;
  }
  const blocked = await databaseChangeBlocked(tabId);
  if (blocked) return blocked;
  if (change.kind === "drop") {
    const closed = await closeTabsOnDatabase(profileId, change.name, tabId);
    if (!closed) {
      return `A tab using "${change.name}" has unsaved changes. Save or discard them, then drop the database.`;
    }
  }
  return null;
}

/** A clearer message for a failed DROP DATABASE. */
export function describeDropError(message: string, database: string): string {
  if (/being accessed by other users|currently in use/i.test(message)) {
    return `Other sessions are still connected to "${database}" (another app, or another saved connection to this server). Close them and try again.\n\n${message}`;
  }
  return message;
}
