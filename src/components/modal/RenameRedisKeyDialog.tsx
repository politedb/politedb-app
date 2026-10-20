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
import { showMessage } from "src/lib/system-dialog";
import { KeyIcon } from "../icons";

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
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNextName(keyName);
  }, [open, keyName]);

  const handleRename = useCallback(async () => {
    const trimmed = nextName.trim();
    if (!trimmed || trimmed === keyName) {
      onClose();
      return;
    }

    setRenaming(true);
    try {
      await onConfirm(trimmed);
      onClose();
    } catch (e) {
      const message = e instanceof Error ? e.message : "Rename key failed.";
      void showMessage(message, { title: "Error", kind: "error" });
    } finally {
      setRenaming(false);
    }
  }, [keyName, nextName, onClose, onConfirm]);

  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DialogHeader className="border-b border-neutral-200">
        <DialogTitle className="flex items-center gap-2">
          <KeyIcon className="size-4 text-neutral-600" />
          Rename Redis key
        </DialogTitle>
      </DialogHeader>
      <DialogContent className="gap-2">
        <p className="text-sm text-neutral-700">
          Enter a new name for <strong>{keyName}</strong>.
        </p>
        <Input
          value={nextName}
          onInput={(e) => setNextName((e.target as HTMLInputElement).value)}
          placeholder="New key name"
          className="h-9 rounded-lg border border-neutral-300 text-sm"
          autoFocus
        />
      </DialogContent>
      <DialogFooter className="justify-end">
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
  );
}
