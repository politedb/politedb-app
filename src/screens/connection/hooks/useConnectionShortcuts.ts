import { useEffect, useRef } from "preact/hooks";

type ShortcutActions = {
  openSql: () => void;
  beforeSaveChanges: () => void;
  saveChanges: () => Promise<void> | void;
  refresh: () => Promise<void> | void;
  closeWindow: (id: string, e: MouseEvent) => Promise<void> | void;
  closeTab: (tabId: string, skipCheck?: boolean) => Promise<void> | void;
};

export function useConnectionShortcuts(params: {
  activeWindowId: string | null;
  activeProfileScreen: string;
  actions: ShortcutActions;
}) {
  const activeWindowIdRef = useRef(params.activeWindowId);
  const activeProfileScreenRef = useRef(params.activeProfileScreen);
  const actionsRef = useRef(params.actions);

  useEffect(() => {
    activeWindowIdRef.current = params.activeWindowId;
  }, [params.activeWindowId]);

  useEffect(() => {
    activeProfileScreenRef.current = params.activeProfileScreen;
  }, [params.activeProfileScreen]);

  useEffect(() => {
    actionsRef.current = params.actions;
  }, [params.actions]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = navigator.platform.toLowerCase().includes("mac");
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (!mod) return;

      const target = e.target as HTMLElement;
      const inEditable =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      const key = e.key.toLowerCase();

      // Allow Cmd/Ctrl+S even inside inputs
      if (inEditable) {
        if (key === "s") {
          e.preventDefault();
          e.stopPropagation();
          void actionsRef.current.beforeSaveChanges();
        }
        return;
      }

      if (key === "t") {
        e.preventDefault();
        e.stopPropagation();
        actionsRef.current.openSql();
        return;
      }

      if (key === "s") {
        e.preventDefault();
        e.stopPropagation();
        void actionsRef.current.beforeSaveChanges();
        return;
      }

      if (key === "r") {
        e.preventDefault();
        e.stopPropagation();
        void actionsRef.current.refresh();
        return;
      }

      if (key === "w") {
        e.preventDefault();
        e.stopPropagation();

        const winId = activeWindowIdRef.current;
        const tabId = activeProfileScreenRef.current;

        if (winId) {
          const syntheticEvent = new MouseEvent("click", {
            bubbles: true,
            cancelable: true,
          }) as unknown as MouseEvent;
          void actionsRef.current.closeWindow(winId, syntheticEvent);
          return;
        }

        if (tabId && tabId !== "main") {
          void actionsRef.current.closeTab(tabId);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
