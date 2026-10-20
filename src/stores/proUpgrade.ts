import { create } from "zustand";
import type { ProFeature } from "src/lib/license/proAccess";

type ProUpgradeStoreState = {
  /** Feature the user tried to use without Pro; `null` when the dialog is closed. */
  feature: ProFeature | null;
  open: (feature: ProFeature) => void;
  close: () => void;
};

export const useProUpgradeStore = create<ProUpgradeStoreState>((set) => ({
  feature: null,
  open: (feature) => set({ feature }),
  close: () => set({ feature: null }),
}));
