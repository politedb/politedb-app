import { useCallback, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { ErrorDialog } from "./ErrorDialog";

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
  const [error, setError] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);

  const handleDrop = useCallback(async () => {
    setError(null);
    setDropping(true);
    try {
      await onConfirm();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Drop table failed.");
    } finally {
      setDropping(false);
    }
  }, [onClose, onConfirm]);

  return (
    <>
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

      {error && <ErrorDialog open={true} error={error} onClose={onClose} />}
    </>
  );
}
