import { create } from "zustand";
import { DatabaseEngine, OpenWindow, SqlEditorWindow } from "../types";
import {
  hasProductionTag,
  normalizeQuerySafetyMode,
  type QuerySafetyMode,
} from "src/lib/querySafety";

export type { QuerySafetyMode } from "src/lib/querySafety";

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

  // Navigation
  setActiveProfileScreen: (tabId: string) => void;

  // Window focus (per tab)
  setActiveWindowId: (tabId: string, windowId: string | null) => void;

  // Window lifecycle (per tab)
  addWindow: (tabId: string, window: OpenWindow) => void;
  removeWindow: (tabId: string, windowId: string) => void;
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

export const useScreenStore = create<ScreenState>((set) => ({
  activeProfileScreen: "main",
  profileTabs: [],

  querySafetyByProfileId: {},

  openWindows: {},
  activeWindowId: {},

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

  removeWindow: (tabId, windowId) =>
    set((s) => {
      const prev = s.openWindows[tabId] ?? [];
      const next = prev.filter((w) => w.id !== windowId);

      const currActive = s.activeWindowId[tabId];
      const lastWindowId = next.length > 0 ? next[next.length - 1].id : null;
      const activeWindowId =
        currActive === windowId
          ? { ...s.activeWindowId, [tabId]: lastWindowId }
          : s.activeWindowId;

      schedulePersistentSave();

      return {
        openWindows: { ...s.openWindows, [tabId]: next },
        activeWindowId,
      };
    }),

  replaceWindows: (tabId, windows) =>
    set((s) => {
      schedulePersistentSave();
      return {
        openWindows: { ...s.openWindows, [tabId]: windows },
        activeWindowId: {
          ...s.activeWindowId,
          [tabId]: windows.length > 0 ? windows[windows.length - 1].id : null,
        },
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
      return { profileTabs, activeProfileScreen, openWindows, activeWindowId };
    }),

  resetTabs: (profileTabs) =>
    set((s) => {
      schedulePersistentSave();
      let querySafetyByProfileId = { ...s.querySafetyByProfileId };
      for (const t of profileTabs) {
        querySafetyByProfileId[t.profileId] = tabSafetyMode(t);
      }
      return { ...s, profileTabs, querySafetyByProfileId };
    }),
}));
