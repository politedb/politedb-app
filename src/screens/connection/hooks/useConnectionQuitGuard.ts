import { useEffect } from "preact/hooks";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { appQuit } from "src/lib/tauri/app";
import { usePersistentStore } from "src/stores/persistentStore";
import { useUnsavedChangesDialogStore } from "src/stores/unsavedChangesDialog";
import {
  discardAllConnectionChanges,
  hasAnyUnsavedConnectionChanges,
} from "../lib/unsavedChanges";
import { withCloseAdmission } from "../lib/dump/dumpJobCloseGuard";

/** Set once the app quits on purpose: the close request then passes. */
let forceQuit = false;

async function quitApp() {
  forceQuit = true;
  try {
    await appQuit();
  } catch {
    await getCurrentWindow().destroy();
  }
}

/**
 * The answer "discard and quit" of the unsaved-changes prompt. A job may
 * have started since the prompt opened: checked again before anything is
 * discarded (refused: the changes are kept).
 */
export async function discardAndQuitApp(): Promise<void> {
  await withCloseAdmission({ kind: "app" }, undefined, async () => {
    discardAllConnectionChanges();
    await usePersistentStore.getState().saveNow();

    useUnsavedChangesDialogStore.getState().close();
    await quitApp();
  });
}

/**
 * Guards closing the window (quitting): refused while a backup or restore
 * runs (D8), then the unsaved-changes prompt. Mounted for the window's
 * whole life (the app layout), so leaving a connection screen never drops
 * it while a job still runs.
 */
export function useConnectionQuitGuard() {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;

    let appWindow: ReturnType<typeof getCurrentWindow>;
    try {
      appWindow = getCurrentWindow();
    } catch {
      // No native window (the web dev server): nothing to guard.
      return;
    }
    void appWindow
      .onCloseRequested((event) => {
        if (forceQuit) return;

        event.preventDefault();

        // Refused while a backup or restore runs, before the prompt; the
        // quit holds its lease until it is done.
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
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  return { discardAndQuitApp };
}
