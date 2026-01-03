import { create } from "zustand";

export type Tab = {
  id: string;
  label: string;
  connectionId: string; // localStorage key
  connectionData: any;
  runtimeConnectionId?: string; // Actual connection ID from connectionCreate
};

type ScreenState = {
  activeScreen: string | null;
  setActiveScreen: (screen: string) => void;
  tabs: Tab[];
  setTabs: (tabs: Tab[]) => void;
};

export const useScreenStore = create<ScreenState>((set) => ({
  activeScreen: "main",
  tabs: [],
  setActiveScreen: (screen: string | null) => set({ activeScreen: screen }),
  setTabs: (tabs: Tab[]) => set({ tabs: tabs }),
}));
