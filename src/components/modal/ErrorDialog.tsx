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
  error: string;
  onClose: () => void;
}

export function ErrorDialog({ open, error, onClose }: Props) {
  return (
    <Dialog
      className="max-w-xs gap-2"
      showCloseButton={false}
      open={open}
      onClose={onClose}
    >
      <DialogContent>
        <DialogHeader className="p-0">
          <DialogTitle className="text-base">Error</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 text-sm text-neutral-800">
          <p>ERROR: {error}</p>
          <p>All changes were reverted (DDL statements can't be reverted).</p>
        </div>
      </DialogContent>
      <DialogFooter className="justify-center">
        <Button className="w-full py-1.5" variant="default" onClick={onClose}>
          OK
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
