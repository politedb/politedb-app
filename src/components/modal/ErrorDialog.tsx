import { Button } from "../common/Button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  type DialogSize,
} from "../common/Dialog";
import { cn } from "src/utils/cn";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";

interface Props {
  open: boolean;
  error: string;
  title?: string;
  size?: DialogSize;
  onClose: () => void;
  onRetry?: () => void;
  /** Query / runtime errors: scrollable details, no DDL revert note. */
  variant?: "default" | "execution";
  /** When false, hides the DDL revert note. Ignored when variant is execution. */
  showRevertNote?: boolean;
  hint?: string;
  backdropClassName?: string;
}

export function ErrorDialog({
  open,
  error,
  title: titleProp,
  size: sizeProp,
  onClose,
  onRetry,
  variant = "default",
  showRevertNote = true,
  hint: hintProp,
  backdropClassName,
}: Props) {
  const isExecution = variant === "execution";
  const title = titleProp ?? (isExecution ? "Execution" : "Error");
  const size = sizeProp ?? (isExecution ? "md" : "xs");
  const hint =
    hintProp ??
    (isExecution
      ? "Check connection, permissions, or try a smaller LIMIT."
      : undefined);
  const showRevert = !isExecution && showRevertNote;
  const detail = error.replace(/^\s*ERROR:\s*/i, "").trim() || error;

  return (
    <Dialog
      className="gap-2"
      backdropClassName={backdropClassName}
      showCloseButton={false}
      open={open}
      onClose={onClose}
      size={size}
    >
      <DialogContent>
        <DialogHeader className="p-0">
          <div class="flex items-center justify-between gap-3">
            <DialogTitle
              className={cn("text-base", isExecution && "text-red-600")}
            >
              {title}
            </DialogTitle>
            {isExecution ? (
              <span class="shrink-0 rounded-md bg-red-50 px-2 py-0.5 text-sm font-semibold text-red-700">
                ERROR
              </span>
            ) : null}
          </div>
        </DialogHeader>

        <div class="space-y-2 text-sm text-neutral-800">
          {isExecution ? (
            <>
              <div class="text-sm font-semibold text-neutral-500">Details</div>
              <OverlayScrollArea
                className="max-h-64 rounded-lg border border-neutral-200 bg-neutral-50"
                contentClassName="wrap-break-word whitespace-pre-wrap p-3 font-mono text-sm leading-5 text-neutral-900"
                horizontal
                vertical
              >
                {detail}
              </OverlayScrollArea>
            </>
          ) : (
            <OverlayScrollArea
              className="max-h-64 rounded-lg border border-red-100 bg-red-50/40"
              contentClassName="wrap-break-word whitespace-pre-wrap p-3 font-mono text-sm leading-5 text-red-600"
              horizontal
              vertical
            >
              ERROR: {detail}
            </OverlayScrollArea>
          )}
          {showRevert ? (
            <p>All changes were reverted (DDL statements can't be reverted).</p>
          ) : null}
          {hint ? (
            <p class="text-xs leading-5 text-neutral-500">{hint}</p>
          ) : null}
        </div>
      </DialogContent>
      <DialogFooter className="flex-col justify-center pt-0">
        {onRetry && (
          <Button
            className={cn("w-full py-1.5")}
            variant="default"
            onClick={onRetry}
          >
            Try Again
          </Button>
        )}
        <Button
          className={cn("w-full py-1.5")}
          variant={onRetry ? "shadow" : "default"}
          onClick={onClose}
        >
          OK
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
