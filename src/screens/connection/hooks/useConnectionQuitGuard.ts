import { useCallback, useEffect, useRef } from "preact/hooks";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appQuit } from "src/lib/tauri/app";
import { usePersistentStore } from "src/stores/persistentStore";
import { useUnsavedChangesDialogStore } from "src/stores/unsavedChangesDialog";
import {
  discardAllConnectionChanges,
  hasAnyUnsavedConnectionChanges,
} from "../lib/unsavedChanges";
import { withCloseAdmission } from "../lib/dump/dumpJobCloseGuard";

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

        // Refused while a backup or restore runs (D8), before the unsaved
        // changes prompt; the quit holds its lease until it is done.
        void withCloseAdmission({ kind: "app" }, undefined, async () => {
          if (!hasAnyUnsavedConnectionChanges()) {
            await quitApp();
            return;
          }
          // The prompt's own answer is admitted again (discardAndQuitApp).
          useUnsavedChangesDialogStore.getState().openForAppQuit();
        });
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
    // A job may have started since the prompt opened: checked again
    // before anything is discarded (refused: the changes are kept).
    await withCloseAdmission({ kind: "app" }, undefined, async () => {
      discardAllConnectionChanges();
      await usePersistentStore.getState().saveNow();

      useUnsavedChangesDialogStore.getState().close();
      await quitApp();
    });
  }, [quitApp]);

  return { discardAndQuitApp };
}
