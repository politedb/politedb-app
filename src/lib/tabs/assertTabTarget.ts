import { resolveTabTarget, targetMatches } from "src/lib/tabs/tabTarget";
import { useConnectionStore } from "src/stores/connection";
import { useProfileStore } from "src/stores/profile";
import {
  runtimeRefusalOf,
  useRuntimeTargetsStore,
} from "src/stores/runtimeTargets";
import { useScreenStore } from "src/stores/screen";

/*
 * Execution guard of connection tabs (plan tab-database-reconnect D3): work
 * runs on a runtime connection only when it is the tab's own, opened on the
 * tab's target. Unknown or unrecorded fails closed. Revision freshness is
 * the backend's (R20); this guard covers target and ownership.
 */

export const TAB_TARGET_UNKNOWN =
  "This tab's database could not be determined. Close it and open the database again.";
export const RUNTIME_STALE_MESSAGE =
  "The connection settings changed. Reconnect this tab.";
export const RUNTIME_UNCONFIRMED_MESSAGE =
  "This tab's connection could not be confirmed. Reconnect the tab.";
export const RUNTIME_NOT_THE_TABS =
  "This tab no longer uses this connection. Reconnect the tab.";

export type TabTargetRefusalCode =
  | "TAB_CLOSED"
  | "TAB_TARGET_UNKNOWN"
  | "RUNTIME_STALE"
  | "RUNTIME_IDENTITY_MISSING"
  | "RUNTIME_NOT_AUTHORITATIVE"
  | "RUNTIME_TARGET_MISMATCH";

export type TabTargetRefusal = {
  code: TabTargetRefusalCode;
  message: string;
};

/** A refused execution; its message is meant for the user. */
export class TabTargetError extends Error {
  readonly code: TabTargetRefusalCode;
  constructor(refusal: TabTargetRefusal) {
    super(refusal.message);
    this.name = "TabTargetError";
    this.code = refusal.code;
  }
}

export function isTabTargetError(err: unknown): err is TabTargetError {
  return err instanceof TabTargetError;
}

/**
 * Whether `text` only says the tab must be reconnected (or reopened): a
 * refusal of this guard or of the backend (R20). The tab already asks about
 * that once, so an automatic load's error dialog stays quiet about it.
 */
export function isReconnectMessage(text: string | null | undefined): boolean {
  if (!text) return false;
  return (
    text === TAB_TARGET_UNKNOWN ||
    text === RUNTIME_STALE_MESSAGE ||
    text === RUNTIME_UNCONFIRMED_MESSAGE ||
    text === RUNTIME_NOT_THE_TABS ||
    (text.startsWith("This tab shows ") &&
      text.endsWith(" Reconnect the tab.")) ||
    runtimeRefusalOf(text) !== null
  );
}

function tabOf(tabId: string) {
  return useScreenStore.getState().profileTabs.find((t) => t.id === tabId);
}

function resolvedOf(tabId: string) {
  const tab = tabOf(tabId);
  const profile = tab
    ? useProfileStore.getState().getProfileById(tab.profileId)
    : undefined;
  return resolveTabTarget(tab, profile);
}

/**
 * Whether `runtimeId` may serve `tabId`: opened on the tab's target and
 * acquired by this tab. Revision freshness is checked by the backend.
 */
export function runtimeServesTab(tabId: string, runtimeId: string): boolean {
  const { targets, owners } = useRuntimeTargetsStore.getState();
  return (
    owners[runtimeId] === tabId &&
    targetMatches(resolvedOf(tabId).intended, targets[runtimeId])
  );
}

type TableDataMapEntry = { connectionId?: string | null };

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

/** The runtime connection `tabId` works through now (R4), if any. */
export function authoritativeRuntimeOf(tabId: string): string | undefined {
  const tab = tabOf(tabId);
  if (!tab) return undefined;
  if (tab.runtimeConnectionId) return tab.runtimeConnectionId;
  return resolveTabRuntimeConnectionId({
    tabRuntimeConnectionId: tab.runtimeConnectionId,
    activeProfileScreen: tabId,
    tableDataMap: useConnectionStore.getState().tableDataMap,
  });
}

/**
 * Why `tabId` may not run work on `runtimeId` now, or null. Called before a
 * confirmation and again right before dispatch.
 */
export function checkTabTarget(
  tabId: string | null | undefined,
  runtimeId: string | null | undefined
): TabTargetRefusal | null {
  if (!tabId || !tabOf(tabId)) {
    return { code: "TAB_CLOSED", message: RUNTIME_NOT_THE_TABS };
  }
  const resolved = resolvedOf(tabId);
  if (resolved.state === "unknown") {
    return { code: "TAB_TARGET_UNKNOWN", message: TAB_TARGET_UNKNOWN };
  }
  if (!runtimeId) {
    return {
      code: "RUNTIME_NOT_AUTHORITATIVE",
      message: RUNTIME_NOT_THE_TABS,
    };
  }
  const { targets, owners, refused } = useRuntimeTargetsStore.getState();
  if (refused[runtimeId]) {
    return { code: "RUNTIME_STALE", message: RUNTIME_STALE_MESSAGE };
  }
  const runtime = targets[runtimeId];
  if (!runtime) {
    return {
      code: "RUNTIME_IDENTITY_MISSING",
      message: RUNTIME_UNCONFIRMED_MESSAGE,
    };
  }
  if (
    owners[runtimeId] !== tabId ||
    authoritativeRuntimeOf(tabId) !== runtimeId
  ) {
    return {
      code: "RUNTIME_NOT_AUTHORITATIVE",
      message: RUNTIME_NOT_THE_TABS,
    };
  }
  if (!targetMatches(resolved.intended, runtime)) {
    return {
      code: "RUNTIME_TARGET_MISMATCH",
      message: `This tab shows ${resolved.display || "its database"} but is connected to ${runtime.display || "another database"}. Reconnect the tab.`,
    };
  }
  return null;
}

/** Throws a `TabTargetError` when `checkTabTarget` refuses. */
export function assertTabTarget(
  tabId: string | null | undefined,
  runtimeId: string | null | undefined
): void {
  const refusal = checkTabTarget(tabId, runtimeId);
  if (refusal) throw new TabTargetError(refusal);
}

/** Commands that act on a runtime connection without running work on it. */
const UNGUARDED_COMMANDS: ReadonlySet<string> = new Set([
  "connection_remove",
  "connection_list",
]);

/**
 * The last check before a command reaches a runtime connection, whoever
 * sends it: the connection must be its owning tab's authoritative one, on
 * that tab's target. A connection no tab owns is refused.
 */
export function checkRuntimeDispatch(
  cmd: string,
  runtimeId: string
): TabTargetRefusal | null {
  if (UNGUARDED_COMMANDS.has(cmd)) return null;
  const owner = useRuntimeTargetsStore.getState().owners[runtimeId];
  if (!owner) {
    return useRuntimeTargetsStore.getState().refused[runtimeId]
      ? { code: "RUNTIME_STALE", message: RUNTIME_STALE_MESSAGE }
      : {
          code: "RUNTIME_IDENTITY_MISSING",
          message: RUNTIME_UNCONFIRMED_MESSAGE,
        };
  }
  return checkTabTarget(owner, runtimeId);
}
