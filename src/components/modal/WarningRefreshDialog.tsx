import { Button } from "../common/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../common/Dialog";

interface Props {
  open: boolean;
  onClose: () => void;
  onDiscard: () => void;
}

export function WarningRefreshDialog({ open, onClose, onDiscard }: Props) {
  return (
    <Dialog
      className="max-w-xs"
      showCloseButton={false}
      open={open}
      onClose={onClose}
    >
      <DialogContent>
        <DialogHeader className="p-0">
          <DialogTitle className="text-base">Warning</DialogTitle>
        </DialogHeader>

        <div className="text-sm text-neutral-800">
          <p>Discard all changes?</p>
          <p>Tips: You can commit the changes by:</p>
          <p>1. Command + S.</p>
          <p>2. Use the top left segment control.</p>
        </div>
      </DialogContent>
      <DialogFooter className="justify-center">
        <Button className="py-1.5" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button className="py-1.5" variant="default" onClick={onDiscard}>
          Discard
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
