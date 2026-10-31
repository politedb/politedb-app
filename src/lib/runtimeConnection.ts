import { profileConnect } from "src/lib/tauri/profile";
import { connectionRemove } from "src/lib/tauri/connection";
import { operationCancel } from "src/lib/tauri/operation";
import {
  setRuntimeDispatchGuard,
  setRuntimeRefusalHandler,
} from "src/lib/tauri/runtimeAdmission";
import { resolveTabTarget, tabLabelFor } from "src/lib/tabs/tabTarget";
import {
  TAB_TARGET_UNKNOWN,
  TabTargetError,
  checkRuntimeDispatch,
  resolveTabRuntimeConnectionId,
  runtimeServesTab,
} from "src/lib/tabs/assertTabTarget";
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

export {
  tabLabelFor,
  TAB_TARGET_UNKNOWN,
  resolveTabRuntimeConnectionId,
  runtimeServesTab,
};

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
 * Makes `runtimeId` the tab's connection (bumping its epoch, R5). Table data
 * loaded through any other connection is dropped, never relabelled as this
 * one's (R4); the tab has no unsaved changes here (R21).
 */
export function installTabRuntime(tabId: string, runtimeId: string): void {
  const previous = tabOf(tabId)?.runtimeConnectionId;
  useRuntimeTargetsStore.getState().setOwner(runtimeId, tabId);
  if (previous && previous !== runtimeId) invalidateTabData(tabId);
  else detachForeignTableConnections(tabId, runtimeId);
  useScreenStore
    .getState()
    .updateTab(tabId, { runtimeConnectionId: runtimeId });
}

/** Drops the table entries of `tabId` loaded through another connection. */
export function detachForeignTableConnections(
  tabId: string,
  runtimeId: string
): void {
  const { tableDataMap } = useConnectionStore.getState();
  const prefix = `${tabId}.`;
  const foreign = Object.entries(tableDataMap)
    .filter(
      ([key, entry]) =>
        key.startsWith(prefix) &&
        !!entry?.connectionId &&
        entry.connectionId !== runtimeId
    )
    .map(([key]) => key);
  invalidateTableKeys(foreign, []);
}

/**
 * Drops everything a tab loaded through its connection (R5): table data,
 * rows, caches, filters, sort, structure and constraints; running row
 * streams are stopped. Unsaved changes are not here (R21).
 */
export function invalidateTabData(tabId: string): void {
  const prefix = `${tabId}.`;
  const store = useConnectionStore.getState();
  const keys = new Set<string>();
  for (const map of [
    store.tableDataMap,
    store.tableRowsByKey,
    store.columnsCache,
    store.sizeInfoCache,
    store.tableFilterByKey,
    store.tableSortByKey,
  ]) {
    for (const key of Object.keys(map ?? {})) {
      if (key.startsWith(prefix)) keys.add(key);
    }
  }
  invalidateTableKeys([...keys], [tabId]);
}

function invalidateTableKeys(keys: string[], wholeTabs: string[]): void {
  if (!keys.length && !wholeTabs.length) return;
  const store = useConnectionStore.getState();
  for (const key of keys) {
    const opId = store.getRowsWindowInfo(key)?.opId;
    if (opId) operationCancel(opId).catch(() => {});
    store.clearRows(key);
  }
  const drop = <T>(map: Record<string, T> | undefined) => {
    if (!map) return map;
    const next = { ...map };
    for (const key of keys) delete next[key];
    return next;
  };
  const dropTabs = <T>(map: Record<string, T> | undefined) => {
    if (!map) return map;
    const next = { ...map };
    for (const id of wholeTabs) delete next[id];
    return next;
  };
  useConnectionStore.setState((s) => ({
    tableDataMap: drop(s.tableDataMap)!,
    tableRowCacheByKey: drop(s.tableRowCacheByKey)!,
    columnsCache: drop(s.columnsCache)!,
    sizeInfoCache: drop(s.sizeInfoCache)!,
    tableFilterByKey: drop(s.tableFilterByKey)!,
    tableSortByKey: drop(s.tableSortByKey)!,
    selectedRowByKey: drop(s.selectedRowByKey)!,
    virtualKeySafetyByKey: drop(s.virtualKeySafetyByKey)!,
    tableStructure: dropTabs(s.tableStructure)!,
    tableConstraints: dropTabs(s.tableConstraints)!,
  }));
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

/**
 * Stops the row streams still running in a tab whose epoch moved (R5): they
 * belong to work that may no longer publish, and nothing else would end a
 * stream that stalled.
 */
export function retireTabStreams(tabId: string): void {
  const store = useConnectionStore.getState();
  const prefix = `${tabId}.`;
  for (const key of Object.keys(store.tableRowsByKey ?? {})) {
    if (!key.startsWith(prefix)) continue;
    const info = store.getRowsWindowInfo(key);
    if (!info?.opId || !info.running) continue;
    operationCancel(info.opId).catch(() => {});
    store.endRowsStream(key, info.opId);
  }
}

useScreenStore.subscribe((state, previous) => {
  if (state.tabEpoch === previous.tabEpoch) return;
  for (const [tabId, epoch] of Object.entries(state.tabEpoch)) {
    if (previous.tabEpoch[tabId] !== epoch) retireTabStreams(tabId);
  }
});

// D3: every command on a runtime connection is checked right before it is
// sent, after whatever confirmation preceded it.
setRuntimeDispatchGuard((cmd, runtimeId) => {
  const refusal = checkRuntimeDispatch(cmd, runtimeId);
  if (refusal) throw new TabTargetError(refusal);
});
