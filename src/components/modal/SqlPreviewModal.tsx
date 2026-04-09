import { useCallback, useState } from "preact/hooks";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogContent,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { CopyIcon, CopyCheck } from "src/components/icons";

export function SqlPreviewModal(props: {
  open: boolean;
  onClose: () => void;
  sqlPreview: string;
}) {
  const { open, onClose, sqlPreview } = props;

  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async (sql: string) => {
    setCopied(true);
    await navigator.clipboard.writeText(sql);
    setTimeout(() => setCopied(false), 1000);
  }, []);

  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>SQL Preview</DialogTitle>
      </DialogHeader>
      <DialogContent className="pt-0">
        <div class="flex items-center justify-between rounded border border-neutral-200 bg-neutral-100">
          <div class="p-2 font-mono text-xs break-all whitespace-pre-wrap">
            {sqlPreview}
          </div>
          <Button
            variant="ghost"
            class="h-7 px-2 text-xs text-neutral-500 hover:bg-neutral-100 hover:text-neutral-700"
            onClick={(e) => {
              e.stopPropagation();
              void onCopy(sqlPreview);
            }}
            title={copied ? "Copied!" : "Copy"}
          >
            {copied ? (
              <CopyCheck className="size-4" />
            ) : (
              <CopyIcon className="size-4" />
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
