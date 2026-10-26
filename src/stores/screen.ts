import { create } from "zustand";
import { useObjectDraftStore } from "./objectDrafts";
import { DatabaseEngine, OpenWindow, SqlEditorWindow } from "../types";
import {
  hasProductionTag,
  normalizeQuerySafetyMode,
  type QuerySafetyMode,
} from "@root/src/lib/queries/querySafety";

export type { QuerySafetyMode } from "@root/src/lib/queries/querySafety";

function tabSafetyMode(
  t: Pick<ProfileTab, "querySafetyMode" | "isLocked">
): QuerySafetyMode {
  if (
    t.querySafetyMode === "lock" ||
    t.querySafetyMode === "safe" ||
    t.querySafetyMode === "production"
  ) {
    return t.querySafetyMode;
  }
  if (t.querySafetyMode === "default") return "default";
  return t.isLocked ? "lock" : "default";
}

function schedulePersistentSave() {
  queueMicrotask(async () => {
    const mod = await import("src/stores/persistentStore");
    mod.usePersistentStore.getState().scheduleSave();
  });
}

/**
 * A "Profile Tab" represents one connected workspace/profile in the UI.
 * - profileId: persistent identity from backend (stable across sessions)
 * - runtimeConnectionId: runtime identity (created when user connects)
 */
export type ProfileTab = {
  id: string; // UI tab id (local)
  label: string; // Display name (e.g. "Local Postgres", "Prod DB")
  engine: DatabaseEngine;

  profileId: string; // Persistent identity (backend uuid or legacy mapped id)
  runtimeConnectionId?: string; // Runtime connection handle (created on connect)
  databaseOverride?: string;
  /** True when query safety is Lock (mutations blocked); does not block closing the tab. */
  isLocked?: boolean;
  querySafetyMode?: QuerySafetyMode;
  profileTags?: string[];
};

/**
 * Window state is scoped per tab (per connection/profile):
 * - openWindows[tabId] = list of opened windows in that tab (table/sql)
 * - activeWindowId[tabId] = current focused window id in that tab
 */
type ScreenState = {
  activeProfileScreen: string; // current active tabId, or "main"

  profileTabs: ProfileTab[];

  /** Last chosen query safety per saved profile (survives closing the tab). */
  querySafetyByProfileId: Record<string, QuerySafetyMode>;

  openWindows: Record<string, OpenWindow[]>;
  activeWindowId: Record<string, string | null>;

  /**
   * Bumped whenever a connection screen tab is closed, reset or connects to
   * a different runtime connection. Never reset, so work started in one
   * lifetime of a tab id can tell it is no longer current.
   */
  tabEpoch: Record<string, number>;

  // Navigation
  setActiveProfileScreen: (tabId: string) => void;

  // Window focus (per tab)
  setActiveWindowId: (tabId: string, windowId: string | null) => void;

  // Window lifecycle (per tab)
  addWindow: (tabId: string, window: OpenWindow) => void;
  updateWindow: (
    tabId: string,
    windowId: string,
    patch: Partial<OpenWindow>
  ) => void;
  removeWindow: (tabId: string, windowId: string) => void;
  /**
   * Close several windows at once. A surviving active window stays active;
   * otherwise the nearest survivor to its right (in the old order), else to
   * its left, else none.
   */
  removeWindows: (tabId: string, windowIds: string[]) => void;
  replaceWindows: (tabId: string, windows: OpenWindow[]) => void;
  clearWindows: (tabId: string) => void;
  updateSqlWindowContent: (
    tabId: string,
    windowId: string,
    patch: Pick<SqlEditorWindow, "content" | "title">
  ) => void;

  // Tabs lifecycle
  addTab: (tab: ProfileTab) => void;
  updateTab: (id: string, patch: Partial<ProfileTab>) => void;
  removeTab: (id: string) => void;
  resetTabs: (profileTabs: ProfileTab[]) => void;
};

/** Epochs only grow; a removed tab keeps its last value for a re-add. */
function bumpEpochs(
  epochs: Record<string, number>,
  tabIds: string[]
): Record<string, number> {
  const next = { ...epochs };
  for (const id of new Set(tabIds)) next[id] = (next[id] ?? 0) + 1;
  return next;
}

/**
 * The window to activate after closing `closing`: the current one if it
 * survives, else the nearest survivor to its right, else to its left.
 */
export function activeAfterClose(
  windows: OpenWindow[],
  closing: Set<string>,
  current: string | null | undefined
): string | null {
  if (current && !closing.has(current)) {
    return windows.some((w) => w.id === current) ? current : null;
  }
  const index = windows.findIndex((w) => w.id === current);
  if (index === -1) {
    const survivors = windows.filter((w) => !closing.has(w.id));
    return survivors.length ? survivors[survivors.length - 1]!.id : null;
  }
  for (let i = index + 1; i < windows.length; i++) {
    if (!closing.has(windows[i]!.id)) return windows[i]!.id;
  }
  for (let i = index - 1; i >= 0; i--) {
    if (!closing.has(windows[i]!.id)) return windows[i]!.id;
  }
  return null;
}

export const useScreenStore = create<ScreenState>((set) => ({
  activeProfileScreen: "main",
  profileTabs: [],

  querySafetyByProfileId: {},

  openWindows: {},
  activeWindowId: {},
  tabEpoch: {},

  /* -------------------------------------------------------------------------- */
  /* Navigation                                                                 */
  /* -------------------------------------------------------------------------- */

  setActiveProfileScreen: (tabId) => {
    set({ activeProfileScreen: tabId });
    schedulePersistentSave();
  },
  /* -------------------------------------------------------------------------- */
  /* Window focus (per tab)                                                     */
  /* -------------------------------------------------------------------------- */

  setActiveWindowId: (tabId, windowId) =>
    set((s) => {
      const next = {
        activeWindowId: {
          ...s.activeWindowId,
          [tabId]: windowId,
        },
      };

      schedulePersistentSave();
      return next;
    }),

  /* -------------------------------------------------------------------------- */
  /* Window lifecycle (per tab)                                                 */
  /* -------------------------------------------------------------------------- */

  addWindow: (tabId, window) =>
    set((s) => {
      const prev = s.openWindows[tabId] ?? [];
      schedulePersistentSave();
      return {
        openWindows: {
          ...s.openWindows,
          [tabId]: [...prev, window],
        },
      };
    }),

  updateWindow: (tabId, windowId, patch) =>
    set((s) => {
      const prev = s.openWindows[tabId] ?? [];
      let changed = false;
      const next = prev.map((window) => {
        if (window.id !== windowId) return window;
        const merged = { ...window, ...patch } as OpenWindow;
        const patchKeys = Object.keys(patch) as (keyof typeof patch)[];
        const same = patchKeys.every((key) => {
          const before = (window as Record<string, unknown>)[key as string];
          const after = (patch as Record<string, unknown>)[key as string];
          // Treat undefined/null/false/"" as equivalent empty for no-op patches.
          const empty = (v: unknown) =>
            v === undefined || v === null || v === false || v === "";
          if (empty(before) && empty(after)) return true;
          return before === after;
        });
        if (same) return window;
        changed = true;
        return merged;
      });
      if (!changed) return s;
      schedulePersistentSave();
      return {
        openWindows: {
          ...s.openWindows,
          [tabId]: next,
        },
      };
    }),

  removeWindow: (tabId, windowId) =>
    useScreenStore.getState().removeWindows(tabId, [windowId]),

  removeWindows: (tabId, windowIds) =>
    set((s) => {
      const prev = s.openWindows[tabId] ?? [];
      const closing = new Set(windowIds);
      const next = prev.filter((w) => !closing.has(w.id));
      if (next.length === prev.length) return s;

      const activeWindowId = {
        ...s.activeWindowId,
        [tabId]: activeAfterClose(prev, closing, s.activeWindowId[tabId]),
      };

      schedulePersistentSave();

      return {
        openWindows: { ...s.openWindows, [tabId]: next },
        activeWindowId,
      };
    }),

  replaceWindows: (tabId, windows) =>
    set((s) => {
      schedulePersistentSave();
      const prev = s.openWindows[tabId] ?? [];
      const kept = new Set(windows.map((w) => w.id));
      const removed = new Set(
        prev.filter((w) => !kept.has(w.id)).map((w) => w.id)
      );
      const current = s.activeWindowId[tabId];
      // Keep a surviving active window; else its nearest neighbor.
      const active =
        current && kept.has(current)
          ? current
          : current && removed.has(current)
            ? activeAfterClose(prev, removed, current)
            : windows.length > 0
              ? windows[windows.length - 1].id
              : null;
      return {
        openWindows: { ...s.openWindows, [tabId]: windows },
        activeWindowId: { ...s.activeWindowId, [tabId]: active },
      };
    }),

  clearWindows: (tabId) =>
    set((s) => {
      schedulePersistentSave();
      return {
        openWindows: { ...s.openWindows, [tabId]: [] },
        activeWindowId: { ...s.activeWindowId, [tabId]: null },
      };
    }),

  updateSqlWindowContent: (tabId, windowId, patch) =>
    set((s) => {
      const list = s.openWindows[tabId];
      if (!list) return s;

      let changed = false;
      const nextList = list.map((w) => {
        if (w.id !== windowId) return w;
        if (w.type !== "sql") return w;

        const next = { ...w, ...patch };

        // Note: include title too, not only content
        if (next.content === w.content && next.title === w.title) return w;

        changed = true;
        return next;
      });

      if (!changed) return s;

      schedulePersistentSave();
      return { openWindows: { ...s.openWindows, [tabId]: nextList } };
    }),

  /* -------------------------------------------------------------------------- */
  /* Tabs lifecycle                                                             */
  /* -------------------------------------------------------------------------- */

  addTab: (tab) =>
    set((s) => {
      schedulePersistentSave();
      const explicitSafety =
        tab.querySafetyMode !== undefined || tab.isLocked !== undefined;
      const mode: QuerySafetyMode = explicitSafety
        ? tabSafetyMode(tab)
        : (s.querySafetyByProfileId[tab.profileId] ??
          (hasProductionTag(tab.profileTags) ? "production" : "default"));
      const merged: ProfileTab = {
        ...tab,
        querySafetyMode: mode,
        isLocked: mode === "lock",
      };
      return {
        profileTabs: [...s.profileTabs, merged],
        querySafetyByProfileId: {
          ...s.querySafetyByProfileId,
          [tab.profileId]: mode,
        },
        activeProfileScreen: merged.id,
        openWindows: {
          ...s.openWindows,
          [merged.id]: s.openWindows[merged.id] ?? [],
        },
        activeWindowId: {
          ...s.activeWindowId,
          [merged.id]: s.activeWindowId[merged.id] ?? null,
        },
      };
    }),

  updateTab: (id, patch) =>
    set((s) => {
      const tab = s.profileTabs.find((t) => t.id === id);
      if (!tab) return s;

      const updated: ProfileTab = { ...tab, ...patch };
      const reconnected =
        "runtimeConnectionId" in patch &&
        patch.runtimeConnectionId !== tab.runtimeConnectionId;

      // Only persist if patch changes persisted fields (ignore runtimeConnectionId)
      const { runtimeConnectionId: _rt, ...persistedPatch } = patch as any;
      const shouldPersist = Object.keys(persistedPatch).length > 0;

      if (shouldPersist) schedulePersistentSave();

      let querySafetyByProfileId = s.querySafetyByProfileId;
      let profileTabs = s.profileTabs.map((t) => (t.id === id ? updated : t));

      if ("querySafetyMode" in patch || "isLocked" in patch) {
        const mode = normalizeQuerySafetyMode(tabSafetyMode(updated));
        querySafetyByProfileId = {
          ...s.querySafetyByProfileId,
          [updated.profileId]: mode,
        };
        profileTabs = profileTabs.map((t) =>
          t.profileId === updated.profileId
            ? { ...t, querySafetyMode: mode, isLocked: mode === "lock" }
            : t
        );
      }

      return {
        profileTabs,
        querySafetyByProfileId,
        ...(reconnected ? { tabEpoch: bumpEpochs(s.tabEpoch, [id]) } : {}),
      };
    }),

  removeTab: (id) =>
    set((s) => {
      queueMicrotask(() => {
        void import("src/stores/connectionLog").then(
          ({ useConnectionLogStore }) => {
            useConnectionLogStore.getState().endSession(id);
          }
        );
      });

      const profileTabs = s.profileTabs.filter((t) => t.id !== id);

      const activeProfileScreen =
        s.activeProfileScreen === id
          ? profileTabs.length > 0
            ? profileTabs[profileTabs.length - 1].id
            : "main"
          : s.activeProfileScreen;

      // Optional: you may want to delete window state of the removed tab
      // to avoid memory leak.
      const { [id]: _ow, ...openWindows } = s.openWindows;
      const { [id]: _aw, ...activeWindowId } = s.activeWindowId;

      schedulePersistentSave();
      // The tab's object drafts end with it, closed and clean ones too.
      useObjectDraftStore.getState().clearTab(id);
      return {
        profileTabs,
        activeProfileScreen,
        openWindows,
        activeWindowId,
        tabEpoch: bumpEpochs(s.tabEpoch, [id]),
      };
    }),

  resetTabs: (profileTabs) =>
    set((s) => {
      schedulePersistentSave();
      let querySafetyByProfileId = { ...s.querySafetyByProfileId };
      for (const t of profileTabs) {
        querySafetyByProfileId[t.profileId] = tabSafetyMode(t);
      }
      // A reset starts new tab lifetimes: no draft carries over, even to a
      // tab that keeps its id.
      const drafts = useObjectDraftStore.getState();
      for (const t of [...s.profileTabs, ...profileTabs]) drafts.clearTab(t.id);
      return {
        ...s,
        profileTabs,
        querySafetyByProfileId,
        tabEpoch: bumpEpochs(s.tabEpoch, [
          ...s.profileTabs.map((t) => t.id),
          ...profileTabs.map((t) => t.id),
        ]),
      };
    }),
}));
