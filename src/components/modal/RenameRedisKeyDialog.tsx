import { useCallback, useEffect, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import { ErrorDialog } from "./ErrorDialog";

interface Props {
  open: boolean;
  keyName: string;
  onClose: () => void;
  onConfirm: (nextName: string) => Promise<void>;
}

export function RenameRedisKeyDialog({
  open,
  keyName,
  onClose,
  onConfirm,
}: Props) {
  const [nextName, setNextName] = useState(keyName);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNextName(keyName);
    setError(null);
  }, [open, keyName]);

  const handleRename = useCallback(async () => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === keyName) {
      onClose();
      return;
    }

    setError(null);
    setRenaming(true);
    try {
      await onConfirm(trimmed);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename key failed.");
    } finally {
      setRenaming(false);
    }
  }, [keyName, nextName, onClose, onConfirm]);

  return (
    <>
      <Dialog open={open} onClose={onClose} size="sm">
        <DialogHeader>
          <DialogTitle>Rename Redis key</DialogTitle>
        </DialogHeader>
        <DialogContent className="gap-2 pt-0">
          <p className="text-sm text-neutral-700">
            Enter a new name for <strong>{keyName}</strong>.
          </p>
          <Input
            value={nextName}
            onInput={(e) => setNextName((e.target as HTMLInputElement).value)}
            placeholder="New key name"
            className="h-10 rounded-lg border border-neutral-300 text-sm"
            autoFocus
          />
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={renaming}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={() => void handleRename()}
            disabled={renaming || nextName.trim().length === 0}
          >
            {renaming ? "Renaming..." : "Rename"}
          </Button>
        </DialogFooter>
      </Dialog>

      {error && (
        <ErrorDialog open={true} error={error} onClose={() => setError(null)} />
      )}
    </>
  );
}
