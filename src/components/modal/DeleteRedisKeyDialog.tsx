import { useCallback, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { showMessage } from "src/lib/system-dialog";

interface Props {
  open: boolean;
  keyName: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}

export function DeleteRedisKeyDialog({
  open,
  keyName,
  onClose,
  onConfirm,
}: Props) {
  const [deleting, setDeleting] = useState(false);

  const handleDelete = useCallback(async () => {
    setDeleting(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Delete key failed.";
      onClose();
      void showMessage(message, { title: "Error", kind: "error" });
    } finally {
      setDeleting(false);
    }
  }, [onClose, onConfirm]);

  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DialogHeader>
        <DialogTitle>Delete Redis key '{keyName}'</DialogTitle>
      </DialogHeader>
      <DialogContent className="py-1">
        <p className="text-sm text-neutral-800">
          Permanently delete the Redis key <strong>{keyName}</strong>? This
          cannot be undone.
        </p>
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={deleting}>
          Cancel
        </Button>
        <Button
          variant="outline"
          class="border border-red-500 bg-red-50 text-red-700 hover:bg-red-100"
          onClick={() => void handleDelete()}
          disabled={deleting}
        >
          {deleting ? "Deleting..." : "Delete"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
