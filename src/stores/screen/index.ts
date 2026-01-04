import { create } from "zustand";

export type Tab = {
  id: string;
  label: string;

  // Persistent identity (profile)
  profileId: string; // uuid (backend) OR legacy id mapped

  // Runtime identity (connection)
  runtimeConnectionId?: string;
};

type ScreenState = {
  activeScreen: string;
  tabs: Tab[];

  setActiveScreen: (screen: string) => void;

  addTab: (tab: Tab) => void;
  updateTab: (id: string, patch: Partial<Tab>) => void;
  removeTab: (id: string) => void;
  resetTabs: (tabs: Tab[]) => void;
  setRuntimeConnectionId: (tabId: string, runtimeId: string) => void;
};

export const useScreenStore = create<ScreenState>((set) => ({
  activeScreen: "main",
  tabs: [],

  setActiveScreen: (screen) => set({ activeScreen: screen }),

  addTab: (tab) =>
    set((s) => ({
      tabs: [...s.tabs, tab],
      activeScreen: tab.id,
    })),

  updateTab: (id, patch) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    })),

  removeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id);
      const activeScreen =
        s.activeScreen === id ? (tabs[0]?.id ?? "main") : s.activeScreen;
      return { tabs, activeScreen };
    }),

  resetTabs: (tabs) => set({ tabs }),
  setRuntimeConnectionId: (tabId, runtimeId) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === tabId ? { ...t, runtimeConnectionId: runtimeId } : t
      ),
    })),
}));
