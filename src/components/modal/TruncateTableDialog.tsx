import { useCallback, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Checkbox } from "src/components/common/Checkbox";
import { showMessage } from "src/lib/system-dialog";

type TruncateOptions = {
  restartIdentity: boolean;
  cascade: boolean;
};

interface Props {
  open: boolean;
  tableName: string;
  onClose: () => void;
  onConfirm: (opts: TruncateOptions) => Promise<void>;
}

export function TruncateTableDialog({
  open,
  tableName,
  onClose,
  onConfirm,
}: Props) {
  const [truncating, setTruncating] = useState(false);
  const [restartIdentity, setRestartIdentity] = useState(false);
  const [cascade, setCascade] = useState(true);

  const handleTruncate = useCallback(async () => {
    setTruncating(true);
    try {
      await onConfirm({ restartIdentity, cascade });
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Truncate failed.";
      onClose();
      void showMessage(message, { title: "Error", kind: "error" });
    } finally {
      setTruncating(false);
    }
  }, [onClose, onConfirm, restartIdentity, cascade]);

  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader className="border-b border-neutral-200">
        <DialogTitle className="flex items-center gap-2">
          Truncate table "{tableName}"
        </DialogTitle>
        <DialogDescription>
          Permanently delete all rows in{" "}
          <span class="font-medium text-neutral-900">{tableName}</span>? This
          cannot be undone.
        </DialogDescription>
      </DialogHeader>
      <DialogContent className="gap-2">
        <div class="space-y-3">
          <Checkbox
            checked={restartIdentity}
            onChange={(e) => setRestartIdentity(e.currentTarget.checked)}
            label="Restart identity"
            description="Reset the sequence for the table."
            disabled={truncating}
          />

          <Checkbox
            checked={cascade}
            onChange={(e) => setCascade(e.currentTarget.checked)}
            label="Cascade"
            description="Delete all linked rows by foreign key constraints."
            disabled={truncating}
          />
        </div>
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={truncating}>
          Cancel
        </Button>
        <Button
          variant="outline"
          class="border border-red-500/50 bg-red-50 text-red-700 hover:bg-red-100"
          onClick={() => void handleTruncate()}
          disabled={truncating}
        >
          {truncating ? "Truncating..." : "Truncate"}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
