import { profileConnect } from "src/lib/tauri/profile";
import { connectionRemove } from "src/lib/tauri/connection";
import { operationCancel } from "src/lib/tauri/operation";
import { setRuntimeRefusalHandler } from "src/lib/tauri/runtimeAdmission";
import { resolveTabTarget, targetMatches } from "src/lib/tabs/tabTarget";
import { useConnectionStore } from "src/stores/connection";
import { useProfileStore } from "src/stores/profile";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";
import { useScreenStore } from "src/stores/screen";
import { connectionTabHasChanges } from "src/screens/connection/lib/tabDirty";

/*
 * Runtime connections of connection tabs (plan tab-database-reconnect R1,
 * R3, R4, R21): each tab owns its own, opened on what the tab was opened on
 * (never the profile's own database by default), and only the owner removes
 * it.
 */

type TableDataMapEntry = { connectionId?: string | null };

export const TAB_TARGET_UNKNOWN =
  "This tab's database could not be determined. Close it and open the database again.";
export const TAB_HAS_UNSAVED_CHANGES =
  "This tab has unsaved changes made against the previous settings. Copy or discard them, then reconnect.";
/** A connect that finished after its tab closed or changed target. */
export const TAB_CONNECT_SUPERSEDED = "TAB_CONNECT_SUPERSEDED";

function tabOf(tabId: string) {
  return useScreenStore.getState().profileTabs.find((t) => t.id === tabId);
}

function intendedOf(tabId: string) {
  const tab = tabOf(tabId);
  if (!tab) return null;
  const profile = useProfileStore.getState().getProfileById(tab.profileId);
  return resolveTabTarget(tab, profile).intended;
}

/**
 * Whether `runtimeId` may serve `tabId`: opened on the tab's target and
 * acquired by this tab. Revision freshness is checked by the backend.
 */
export function runtimeServesTab(tabId: string, runtimeId: string): boolean {
  const { targets, owners } = useRuntimeTargetsStore.getState();
  return (
    owners[runtimeId] === tabId &&
    targetMatches(intendedOf(tabId), targets[runtimeId])
  );
}

/**
 * The tab's runtime connection: its own, else a table's connection that
 * this tab acquired on the same target (R4). A foreign or mismatched table
 * connection is never returned.
 */
export function resolveTabRuntimeConnectionId(args: {
  tabRuntimeConnectionId?: string;
  activeProfileScreen: string;
  tableDataMap: Record<string, TableDataMapEntry>;
}): string | undefined {
  const { tabRuntimeConnectionId, activeProfileScreen, tableDataMap } = args;
  if (tabRuntimeConnectionId) return tabRuntimeConnectionId;

  const prefix = `${activeProfileScreen}.`;
  for (const [key, entry] of Object.entries(tableDataMap)) {
    if (!key.startsWith(prefix)) continue;
    const id = entry?.connectionId;
    if (id && runtimeServesTab(activeProfileScreen, id)) return id;
  }
  return undefined;
}

/** Whether any tab or table entry still refers to `runtimeId`. */
function referenced(runtimeId: string, exceptTabId?: string): boolean {
  const tabs = useScreenStore.getState().profileTabs;
  if (
    tabs.some(
      (t) => t.id !== exceptTabId && t.runtimeConnectionId === runtimeId
    )
  ) {
    return true;
  }
  const tableDataMap = useConnectionStore.getState().tableDataMap;
  return Object.entries(tableDataMap).some(
    ([key, entry]) =>
      entry?.connectionId === runtimeId &&
      !(exceptTabId && key.startsWith(`${exceptTabId}.`))
  );
}

/**
 * Removes `runtimeId` on behalf of `tabId`: only when this tab owns it, or
 * when nobody owns it and nothing else refers to it (R4). A foreign
 * connection is left alone.
 */
export async function releaseRuntime(
  runtimeId: string | null | undefined,
  tabId: string
): Promise<void> {
  if (!runtimeId) return;
  const owner = useRuntimeTargetsStore.getState().owners[runtimeId];
  const mine = owner === tabId;
  if (!mine && (owner || referenced(runtimeId, tabId))) return;
  useRuntimeTargetsStore.getState().forget(runtimeId);
  try {
    await connectionRemove(runtimeId);
  } catch {
    // Already gone.
  }
}

const inflight = new Map<string, Promise<string>>();
const generation = new Map<string, number>();

function inflightKey(
  tabId: string,
  profileId: string,
  override: string | null
) {
  return JSON.stringify([tabId, profileId, override]);
}

/**
 * A runtime connection for `tabId`, opened on what the tab was opened on
 * (R1, R3). One in flight per tab and target. `force` opens a new one even
 * when the tab has one (Reload, Save + Connect), refused while the tab has
 * unsaved changes (R21). A connect that finishes after its tab closed,
 * changed target or started another is removed and never installed.
 */
export async function connectTabOnce(
  tabId: string,
  opts: { force?: boolean } = {}
): Promise<string> {
  const tab = tabOf(tabId);
  if (!tab) throw new Error("NO_ACTIVE_TAB");
  const intended = intendedOf(tabId);
  if (!intended) throw new Error(TAB_TARGET_UNKNOWN);
  if (!opts.force && tab.runtimeConnectionId) return tab.runtimeConnectionId;
  // A tab with unsaved changes never gets another connection: they were
  // made against the one it has (R21).
  if (tab.runtimeConnectionId && connectionTabHasChanges(tabId)) {
    throw new Error(TAB_HAS_UNSAVED_CHANGES);
  }

  const key = inflightKey(tabId, intended.profileId, intended.override);
  if (!opts.force) {
    const existing = inflight.get(key);
    if (existing) return existing;
  }
  const gen = (generation.get(tabId) ?? 0) + 1;
  generation.set(tabId, gen);
  const previous = tab.runtimeConnectionId;

  const promise = (async () => {
    const res = await profileConnect(
      intended.profileId,
      intended.override ? { database: intended.override } : undefined
    );
    const id = res.connection.id;
    useRuntimeTargetsStore
      .getState()
      .register(id, res.connection.target, tabId);

    // Still this tab, the same target, the latest connect, no new changes?
    const now = intendedOf(tabId);
    const current =
      generation.get(tabId) === gen &&
      !!now &&
      now.profileId === intended.profileId &&
      now.override === intended.override;
    const dirtied =
      !!tabOf(tabId)?.runtimeConnectionId && connectionTabHasChanges(tabId);
    if (!current || dirtied) {
      await releaseRuntime(id, tabId);
      throw new Error(
        dirtied ? TAB_HAS_UNSAVED_CHANGES : TAB_CONNECT_SUPERSEDED
      );
    }

    installTabRuntime(tabId, id);
    if (previous && previous !== id) await releaseRuntime(previous, tabId);
    return id;
  })().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key);
  });

  inflight.set(key, promise);
  return promise;
}

/**
 * Makes `runtimeId` the tab's connection (bumping its epoch, R5) and
 * detaches table entries of this tab that refer to another connection.
 */
export function installTabRuntime(tabId: string, runtimeId: string): void {
  const previous = tabOf(tabId)?.runtimeConnectionId;
  useRuntimeTargetsStore.getState().setOwner(runtimeId, tabId);
  // Data loaded through another connection is not this one's (R5); the tab
  // has no unsaved changes here (R21), so nothing of the user's is lost.
  if (previous && previous !== runtimeId) invalidateTabData(tabId);
  useScreenStore
    .getState()
    .updateTab(tabId, { runtimeConnectionId: runtimeId });
  detachForeignTableConnections(tabId, runtimeId);
}

/** Drops a tab's loaded table data and stops its row streams. */
export function invalidateTabData(tabId: string): void {
  const store = useConnectionStore.getState();
  const prefix = `${tabId}.`;
  for (const key of Object.keys(store.tableDataMap)) {
    if (!key.startsWith(prefix)) continue;
    const opId = store.getRowsWindowInfo(key)?.opId;
    if (opId) operationCancel(opId).catch(() => {});
    store.clearRows(key);
    store.removeTableDataMap(key);
  }
}

/** Table entries of `tabId` keep only the tab's own connection (R4). */
export function detachForeignTableConnections(
  tabId: string,
  runtimeId: string
): void {
  const { tableDataMap } = useConnectionStore.getState();
  const prefix = `${tabId}.`;
  let changed = false;
  const next = { ...tableDataMap };
  for (const [key, entry] of Object.entries(tableDataMap)) {
    if (!key.startsWith(prefix) || !entry?.connectionId) continue;
    if (entry.connectionId === runtimeId) continue;
    next[key] = { ...entry, connectionId: runtimeId };
    changed = true;
  }
  if (changed) useConnectionStore.setState({ tableDataMap: next });
}

/*
 * A backend refusal of a stale connection (R20) is handled for the tab that
 * still uses that very connection only: its work loses publication
 * authority (epoch) and the tab shows the reconnect message. A late refusal
 * of a connection the tab has since replaced changes nothing.
 */
setRuntimeRefusalHandler((runtimeId, reason) => {
  useRuntimeTargetsStore.getState().markRefused(runtimeId, reason);
  const tabs = useScreenStore
    .getState()
    .profileTabs.filter((t) => t.runtimeConnectionId === runtimeId)
    .map((t) => t.id);
  useScreenStore.getState().bumpTabEpochs(tabs);
});

export const PROFILE_TABS_HAVE_CHANGES =
  "Save or discard the unsaved changes in the tabs of this connection before changing its settings.";

/** Tabs of `profileId` with unsaved changes (R21: settings stay as they are). */
export function profileTabsWithChanges(profileId: string): string[] {
  return useScreenStore
    .getState()
    .profileTabs.filter(
      (t) => t.profileId === profileId && connectionTabHasChanges(t.id)
    )
    .map((t) => t.id);
}

/** A tab's label: the profile's, plus the database it was opened on. */
export function tabLabelFor(
  profileLabel: string,
  target: { kind: string; database?: string } | undefined
): string {
  return target?.kind === "override" && target.database
    ? `${profileLabel} · ${target.database}`
    : profileLabel;
}

/**
 * Whether work started now on `runtimeId` may still publish later (R5): the
 * same tab still uses that connection in the same epoch, and the backend
 * has not refused it.
 */
export function runtimeWorkIsCurrent(runtimeId: string): () => boolean {
  const lifetimeOf = () => {
    const s = useScreenStore.getState();
    const tab = s.profileTabs.find((t) => t.runtimeConnectionId === runtimeId);
    return tab ? `${tab.id}:${s.tabEpoch[tab.id] ?? 0}` : null;
  };
  const start = lifetimeOf();
  return () =>
    start !== null &&
    lifetimeOf() === start &&
    !useRuntimeTargetsStore.getState().refused[runtimeId];
}
