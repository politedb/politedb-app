import { useEffect, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";

export function ImportConnectionPasswordDialog(props: {
  open: boolean;
  busy?: boolean;
  error?: string | null;
  title?: string;
  description?: string;
  submitLabel?: string;
  onClose: () => void;
  onSubmit: (password: string) => void;
}) {
  const {
    open,
    busy,
    error,
    title = "Encrypted export file",
    description = "Enter the file password that was shared with you separately from the export file.",
    submitLabel = "Import",
    onClose,
    onSubmit,
  } = props;
  const [password, setPassword] = useState("");

  useEffect(() => {
    if (!open) setPassword("");
  }, [open]);

  function handleSubmit() {
    if (!password.trim()) return;
    onSubmit(password);
  }

  return (
    <Dialog open={open} onClose={onClose} size="sm" closeOnOutsideClick={!busy}>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>

      <DialogContent className="pt-1">
        <Input
          type="password"
          value={password}
          placeholder="Enter the password..."
          className="h-9 border border-slate-300 text-sm"
          onValueChange={setPassword}
          disabled={busy}
        />
        {error ? (
          <p class="mt-2 text-xs font-medium text-rose-600">{error}</p>
        ) : null}
      </DialogContent>

      <DialogFooter className="gap-2 pt-1">
        <Button
          variant="shadow"
          className="py-1.5"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button
          variant="default"
          className="py-1.5"
          onClick={handleSubmit}
          loading={busy}
          disabled={!password.trim()}
        >
          {submitLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
