import { useEffect, useRef } from "preact/hooks";
import {
  keyboardEventToShortcut,
  matchesShortcut,
  useKeyboardShortcutsStore,
} from "src/stores/keyboardShortcuts";

type ShortcutActions = {
  openSql: () => void;
  beforeSaveChanges: () => void;
  saveChanges: () => Promise<void> | void;
  refresh: () => Promise<void> | void;
  closeWindow: (id: string, e: MouseEvent) => Promise<void> | void;
  closeTab: (tabId: string, skipCheck?: boolean) => Promise<void> | void;
  openSearch?: () => void;
  openSnippets?: () => void;
  insertSnippetByHotkey?: (binding: string) => boolean;
};

export function useConnectionShortcuts(params: {
  activeWindowId: string | null;
  activeProfileScreen: string;
  actions: ShortcutActions;
}) {
  const shortcuts = useKeyboardShortcutsStore((s) => s.shortcuts);
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
    const closeCurrentTarget = () => {
      const winId = activeWindowIdRef.current;
      const tabId = activeProfileScreenRef.current;

      if (winId) {
        const syntheticEvent = new MouseEvent("click", {
          bubbles: true,
          cancelable: true,
        }) as unknown as MouseEvent;
        void actionsRef.current.closeWindow(winId, syntheticEvent);
        return true;
      }

      if (tabId && tabId !== "main") {
        void actionsRef.current.closeTab(tabId);
        return true;
      }

      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const inEditable =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      if (matchesShortcut(e, shortcuts.openSnippets)) {
        e.preventDefault();
        e.stopPropagation();
        actionsRef.current.openSnippets?.();
        return;
      }

      const pressed = keyboardEventToShortcut(e);
      if (pressed && actionsRef.current.insertSnippetByHotkey?.(pressed)) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (inEditable) {
        if (matchesShortcut(e, shortcuts.saveChanges)) {
          e.preventDefault();
          e.stopPropagation();
          void actionsRef.current.beforeSaveChanges();
          return;
        }

        if (matchesShortcut(e, shortcuts.closeCurrent)) {
          if (!closeCurrentTarget()) {
            return;
          }
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        return;
      }

      if (
        matchesShortcut(e, shortcuts.openSearch) ||
        matchesShortcut(e, "Mod+P")
      ) {
        e.preventDefault();
        e.stopPropagation();
        actionsRef.current.openSearch?.();
        return;
      }

      if (matchesShortcut(e, shortcuts.openSql)) {
        e.preventDefault();
        e.stopPropagation();
        actionsRef.current.openSql();
        return;
      }

      if (matchesShortcut(e, shortcuts.saveChanges)) {
        e.preventDefault();
        e.stopPropagation();
        void actionsRef.current.beforeSaveChanges();
        return;
      }

      if (matchesShortcut(e, shortcuts.refresh)) {
        e.preventDefault();
        e.stopPropagation();
        void actionsRef.current.refresh();
        return;
      }

      if (matchesShortcut(e, shortcuts.closeCurrent)) {
        if (!closeCurrentTarget()) {
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
}
