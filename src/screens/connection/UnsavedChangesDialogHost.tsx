import { WarningRefreshDialog } from "src/components/modal/WarningRefreshDialog";
import { discardPendingTabCloseFromDialog } from "./connectionTabClose";
import { getConnectionTabCloseBridge } from "./connectionTabCloseBridge";
import { useUnsavedChangesDialogStore } from "src/stores/unsavedChangesDialog";

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
          void getConnectionTabCloseBridge()?.discardAndQuitApp?.();
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
