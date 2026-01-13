import { create } from "zustand";
import { DatabaseEngine, OpenWindow, SqlEditorWindow } from "../types";

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
};

/**
 * Window state is scoped per tab (per connection/profile):
 * - openWindows[tabId] = list of opened windows in that tab (table/sql)
 * - activeWindowId[tabId] = current focused window id in that tab
 */
type ScreenState = {
  activeProfileScreen: string; // current active tabId, or "main"

  profileTabs: ProfileTab[];

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

  // Runtime connection management
  setRuntimeConnectionId: (tabId: string, runtimeId?: string) => void;
};

export const useScreenStore = create<ScreenState>((set) => ({
  activeProfileScreen: "main",
  profileTabs: [],

  openWindows: {},
  activeWindowId: {},

  /* -------------------------------------------------------------------------- */
  /* Navigation                                                                 */
  /* -------------------------------------------------------------------------- */

  setActiveProfileScreen: (tabId) => set({ activeProfileScreen: tabId }),

  /* -------------------------------------------------------------------------- */
  /* Window focus (per tab)                                                     */
  /* -------------------------------------------------------------------------- */

  setActiveWindowId: (tabId, windowId) =>
    set((s) => ({
      activeWindowId: {
        ...s.activeWindowId,
        [tabId]: windowId,
      },
    })),

  /* -------------------------------------------------------------------------- */
  /* Window lifecycle (per tab)                                                 */
  /* -------------------------------------------------------------------------- */

  addWindow: (tabId, window) =>
    set((s) => {
      const prev = s.openWindows[tabId] ?? [];
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

      // If the active window is removed, caller usually handles switching,
      // but we can also defensively clear it if it points to a removed window.
      const currActive = s.activeWindowId[tabId];
      const lastWindowId = next.length > 0 ? next[next.length - 1].id : null;
      const activeWindowId =
        currActive === windowId
          ? { ...s.activeWindowId, [tabId]: lastWindowId }
          : s.activeWindowId;

      return {
        openWindows: { ...s.openWindows, [tabId]: next },
        activeWindowId,
      };
    }),

  replaceWindows: (tabId, windows) =>
    set((s) => ({
      openWindows: { ...s.openWindows, [tabId]: windows },
      activeWindowId: {
        ...s.activeWindowId,
        [tabId]: windows.length > 0 ? windows[windows.length - 1].id : null,
      },
    })),

  clearWindows: (tabId) =>
    set((s) => ({
      openWindows: { ...s.openWindows, [tabId]: [] },
      activeWindowId: { ...s.activeWindowId, [tabId]: null },
    })),

  updateSqlWindowContent: (tabId, windowId, patch) =>
    set((s) => {
      const list = s.openWindows[tabId];
      if (!list) return s;

      let changed = false;
      const nextList = list.map((w) => {
        if (w.id !== windowId) return w;
        if (w.type !== "sql") return w;

        const next = { ...w, ...patch };
        if (next.content === w.content) return w;

        changed = true;
        return next;
      });

      if (!changed) return s;
      return { openWindows: { ...s.openWindows, [tabId]: nextList } };
    }),

  /* -------------------------------------------------------------------------- */
  /* Tabs lifecycle                                                             */
  /* -------------------------------------------------------------------------- */

  addTab: (tab) =>
    set((s) => ({
      profileTabs: [...s.profileTabs, tab],
      activeProfileScreen: tab.id,

      // Initialize per-tab window state so we never deal with undefined later
      openWindows: { ...s.openWindows, [tab.id]: s.openWindows[tab.id] ?? [] },
      activeWindowId: {
        ...s.activeWindowId,
        [tab.id]: s.activeWindowId[tab.id] ?? null,
      },
    })),

  updateTab: (id, patch) =>
    set((s) => ({
      profileTabs: s.profileTabs.map((t) =>
        t.id === id ? { ...t, ...patch } : t
      ),
    })),

  removeTab: (id) =>
    set((s) => {
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

      return { profileTabs, activeProfileScreen, openWindows, activeWindowId };
    }),

  resetTabs: (profileTabs) =>
    set((s) => {
      // Keep window maps as-is (or you can rebuild them, depending on your flow)
      return { ...s, profileTabs };
    }),

  /* -------------------------------------------------------------------------- */
  /* Runtime connection management                                              */
  /* -------------------------------------------------------------------------- */

  setRuntimeConnectionId: (tabId, runtimeId) =>
    set((s) => ({
      profileTabs: s.profileTabs.map((t) =>
        t.id === tabId ? { ...t, runtimeConnectionId: runtimeId } : t
      ),
    })),
}));
