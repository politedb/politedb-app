import { useCallback, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { showMessage } from "src/lib/system-dialog";

interface Props {
  open: boolean;
  tableName: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function DropTableDialog({
  open,
  tableName,
  onClose,
  onConfirm,
}: Props) {
  const [dropping, setDropping] = useState(false);

  const handleDrop = useCallback(async () => {
    setDropping(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Drop table failed.";
      onClose();
      void showMessage(message, { title: "Error", kind: "error" });
    } finally {
      setDropping(false);
    }
  }, [onClose, onConfirm]);

  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DialogHeader>
        <DialogTitle>Drop table '{tableName}'</DialogTitle>
      </DialogHeader>
      <DialogContent className="py-1">
        <p className="text-sm text-neutral-800">
          Permanently drop the table <strong>{tableName}</strong> and all its
          data? This cannot be undone.
        </p>
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={dropping}>
          Cancel
        </Button>
        <Button
          variant="outline"
          class="border border-red-500 bg-red-50 text-red-700 hover:bg-red-100"
          onClick={() => void handleDrop()}
          disabled={dropping}
        >
          {dropping ? "Dropping..." : "Drop"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
