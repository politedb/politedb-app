import { WarningRefreshDialog } from "src/components/modal/WarningRefreshDialog";
import { discardPendingTabCloseFromDialog } from "../lib/connectionTabClose";
import { getConnectionTabCloseBridge } from "../lib/connectionTabCloseBridge";
import { useUnsavedChangesDialogStore } from "src/stores/unsavedChangesDialog";
import { discardAndQuitApp } from "../hooks/useConnectionQuitGuard";

export function UnsavedChangesDialogHost() {
  const open = useUnsavedChangesDialogStore((s) => s.open);
  const pendingAppQuit = useUnsavedChangesDialogStore((s) => s.pendingAppQuit);
  const close = useUnsavedChangesDialogStore((s) => s.close);

  return (
    <WarningRefreshDialog
      open={open}
      onClose={close}
      onDiscard={() => {
        if (pendingAppQuit) {
          // Not through the connection screen's bridge: quitting works
          // (and is guarded) whatever screen is shown.
          void discardAndQuitApp();
          return;
        }

        const bridge = getConnectionTabCloseBridge();
        if (bridge) {
          void bridge.discardChanges();
          return;
        }

        void discardPendingTabCloseFromDialog();
      }}
    />
  );
}
