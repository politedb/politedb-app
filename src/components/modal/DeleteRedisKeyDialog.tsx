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
import { KeyIcon } from "../icons";

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
      <DialogHeader className="border-b border-neutral-200">
        <DialogTitle className="flex items-center gap-2">
          <KeyIcon className="size-4.5 text-neutral-600" />
          Delete Redis key "{keyName}"
        </DialogTitle>
      </DialogHeader>
      <DialogContent className="gap-2">
        <p className="text-sm text-neutral-800">
          Permanently delete the Redis key{" "}
          <span class="font-semibold text-neutral-900">{keyName}</span>? This
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
