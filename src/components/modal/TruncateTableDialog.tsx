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
import { ErrorDialog } from "./ErrorDialog";

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
  const [error, setError] = useState<string | null>(null);
  const [truncating, setTruncating] = useState(false);
  const [restartIdentity, setRestartIdentity] = useState(false);
  const [cascade, setCascade] = useState(true);

  const handleTruncate = useCallback(async () => {
    setError(null);
    setTruncating(true);
    try {
      await onConfirm({ restartIdentity, cascade });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Truncate failed.");
    } finally {
      setTruncating(false);
    }
  }, [onClose, onConfirm, restartIdentity, cascade]);

  return (
    <>
      <Dialog open={open} onClose={onClose} size="sm">
        <DialogHeader>
          <DialogTitle>Truncate table '{tableName}'</DialogTitle>
          <DialogDescription>
            Permanently delete all rows in <strong>{tableName}</strong>? This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="py-0">
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
            class="border border-red-500 bg-red-50 text-red-700 hover:bg-red-100"
            onClick={() => void handleTruncate()}
            disabled={truncating}
          >
            {truncating ? "Truncating..." : "Truncate"}
          </Button>
        </DialogFooter>
      </Dialog>

      {error && <ErrorDialog open={true} error={error} onClose={onClose} />}
    </>
  );
}
