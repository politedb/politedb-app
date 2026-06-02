import { useCallback, useEffect, useRef } from "preact/hooks";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appQuit } from "src/lib/tauri/app";
import { usePersistentStore } from "src/stores/persistentStore";
import { useUnsavedChangesDialogStore } from "src/stores/unsavedChangesDialog";
import {
  discardAllConnectionChanges,
  hasAnyUnsavedConnectionChanges,
} from "../unsavedChanges";

export function useConnectionQuitGuard() {
  const forceQuitRef = useRef(false);

  const quitApp = useCallback(async () => {
    forceQuitRef.current = true;

    try {
      await appQuit();
    } catch {
      await getCurrentWindow().destroy();
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    void getCurrentWindow()
      .onCloseRequested((event) => {
        if (forceQuitRef.current) return;

        event.preventDefault();

        if (!hasAnyUnsavedConnectionChanges()) {
          void quitApp();
          return;
        }

        useUnsavedChangesDialogStore.getState().openForAppQuit();
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        unlisten = off;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [quitApp]);

  const discardAndQuitApp = useCallback(async () => {
    discardAllConnectionChanges();
    await usePersistentStore.getState().saveNow();

    useUnsavedChangesDialogStore.getState().close();
    await quitApp();
  }, [quitApp]);

  return { discardAndQuitApp };
}
