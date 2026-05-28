import { create } from "zustand";

type UnsavedChangesDialogState = {
  open: boolean;
  pendingCloseTabId: string | null;
  pendingAppQuit: boolean;
  openForRefresh: () => void;
  openForTabClose: (tabId: string) => void;
  openForAppQuit: () => void;
  close: () => void;
};

export const useUnsavedChangesDialogStore = create<UnsavedChangesDialogState>(
  (set) => ({
    open: false,
    pendingCloseTabId: null,
    pendingAppQuit: false,
    openForRefresh: () =>
      set({ open: true, pendingCloseTabId: null, pendingAppQuit: false }),
    openForTabClose: (tabId) =>
      set({ open: true, pendingCloseTabId: tabId, pendingAppQuit: false }),
    openForAppQuit: () =>
      set({ open: true, pendingCloseTabId: null, pendingAppQuit: true }),
    close: () =>
      set({ open: false, pendingCloseTabId: null, pendingAppQuit: false }),
  })
);
