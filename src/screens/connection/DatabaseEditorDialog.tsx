import { Button } from "src/components/common/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import type { DatabaseEditorMode } from "src/hooks/useDatabases";

interface Props {
  open: boolean;
  mode: Exclude<DatabaseEditorMode, null>;
  busy: boolean;
  nameDraft: string;
  setNameDraft: (value: string) => void;
  onClose: () => void;
  onSave: () => void;
}

export function DatabaseEditorDialog({
  open,
  mode,
  busy,
  nameDraft,
  setNameDraft,
  onClose,
  onSave,
}: Props) {
  return (
    <Dialog
      open={open}
      size="xs"
      onClose={onClose}
      closeOnOutsideClick={!busy}
      closeOnEsc={!busy}
    >
      <DialogHeader>
        <DialogTitle>
          {mode === "create" ? "New database" : "Rename database"}
        </DialogTitle>
        <DialogDescription>
          Configure the name for your database.
        </DialogDescription>
      </DialogHeader>
      <DialogContent className="gap-2 pt-0">
        <Input
          value={nameDraft}
          label="Database name"
          placeholder="Enter the name..."
          onInput={(e) => setNameDraft((e.target as HTMLInputElement).value)}
          className="h-9 border border-neutral-300 text-sm"
        />
      </DialogContent>
      <DialogFooter className="pt-1">
        <Button variant="shadow" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button
          variant="default"
          onClick={onSave}
          disabled={busy || !nameDraft.trim()}
        >
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
