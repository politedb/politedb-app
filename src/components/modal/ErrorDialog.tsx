import { Button } from "../common/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type DialogSize,
} from "../common/Dialog";

interface Props {
  open: boolean;
  error: string;
  title?: string;
  size?: DialogSize;
  onClose: () => void;
  onRetry?: () => void;
}

export function ErrorDialog({
  open,
  error,
  title = "Error",
  size = "xs",
  onClose,
  onRetry,
}: Props) {
  return (
    <Dialog
      className="gap-2"
      showCloseButton={false}
      open={open}
      onClose={onClose}
      size={size}
    >
      <DialogContent>
        <DialogHeader className="p-0">
          <DialogTitle className="text-base">{title}</DialogTitle>
        </DialogHeader>

        <div className="space-y-2 text-sm text-neutral-800">
          <p class="max-h-48 overflow-hidden text-ellipsis text-red-600">
            ERROR: {error.replace("ERROR: ", "")}
          </p>
          <p>All changes were reverted (DDL statements can't be reverted).</p>
        </div>
      </DialogContent>
      <DialogFooter className="flex-col justify-center">
        {onRetry && (
          <Button className="w-full py-1.5" variant="default" onClick={onRetry}>
            Try Again
          </Button>
        )}
        <Button
          className="w-full py-1.5"
          variant={onRetry ? "shadow" : "default"}
          onClick={onClose}
        >
          OK
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
