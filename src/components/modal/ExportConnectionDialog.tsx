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
import { Checkbox } from "src/components/common/Checkbox";
import { Input } from "src/components/common/Input";

export type ExportConnectionOptions = {
  filePassword: string;
  includeDbPassword: boolean;
  includeSshPassword: boolean;
};

export function ExportConnectionDialog(props: {
  open: boolean;
  connectionLabel: string;
  busy?: boolean;
  onClose: () => void;
  onConfirm: (options: ExportConnectionOptions) => void;
}) {
  const { open, connectionLabel, busy, onClose, onConfirm } = props;

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [includeDbPassword, setIncludeDbPassword] = useState(true);
  const [includeSshPassword, setIncludeSshPassword] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setPassword("");
      setConfirmPassword("");
      setError(null);
      return;
    }
    setIncludeDbPassword(true);
    setIncludeSshPassword(true);
  }, [open]);

  function handleConfirm() {
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setError(null);
    onConfirm({
      filePassword: password,
      includeDbPassword,
      includeSshPassword,
    });
  }

  return (
    <Dialog open={open} onClose={onClose} size="md" closeOnOutsideClick={!busy}>
      <DialogHeader>
        <DialogTitle>Export for another device</DialogTitle>
        <DialogDescription>
          Create an encrypted, shareable copy of{" "}
          <strong>{connectionLabel}</strong>. Choose which credentials to embed
          inside the encrypted file.
        </DialogDescription>
      </DialogHeader>

      <DialogContent className="space-y-2 pt-1 text-sm text-slate-600">
        <div>
          <div class="mb-2 font-medium text-slate-800">
            Enter the password used to encrypt the export file
          </div>
          <div class="space-y-2">
            <Input
              type="password"
              value={password}
              placeholder="File password"
              className="h-10"
              onValueChange={setPassword}
              disabled={busy}
            />
            <Input
              type="password"
              value={confirmPassword}
              placeholder="Confirm file password"
              className="h-10"
              onValueChange={setConfirmPassword}
              disabled={busy}
            />
          </div>
        </div>

        <div>
          <div class="mb-2 font-medium text-slate-800">
            Include in encrypted file
          </div>
          <div class="space-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5">
            <Checkbox
              checked={includeDbPassword}
              disabled={busy}
              onChange={(e) => setIncludeDbPassword(e.currentTarget.checked)}
              label="Database password"
              description="Resolved from keychain on this device, stored inline in the export."
            />
            <Checkbox
              checked={includeSshPassword}
              disabled={busy}
              onChange={(e) => setIncludeSshPassword(e.currentTarget.checked)}
              label="SSH password"
              description="Only applies when this connection uses SSH password auth."
            />
          </div>
          <p class="mt-2 text-xs text-slate-500">
            SSH private key files are never included. The recipient must copy
            the key file manually.
          </p>
        </div>

        {error ? (
          <p class="text-xs font-medium text-rose-600">{error}</p>
        ) : null}

        <p class="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          {includeDbPassword || includeSshPassword
            ? "Included passwords are protected by the file password, but only share this file with people you trust."
            : "No connection passwords are stored in the file. The recipient will enter them after import."}
        </p>
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
          onClick={handleConfirm}
          loading={busy}
          disabled={!password || !confirmPassword}
        >
          Export
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
