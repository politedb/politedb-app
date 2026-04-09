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
import { ErrorDialog } from "./ErrorDialog";
import { Input } from "../common/Input";

export function NewConnectionGroupDialog(props: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string) => void | Promise<void>;
}) {
  const { open, onClose, onCreate } = props;
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setSaving(false);
      setError(null);
    }
  }, [open]);

  async function handleCreate() {
    try {
      setSaving(true);
      setError(null);
      await onCreate(name);
      onClose();
    } catch (err) {
      const message = String(err);
      if (message.includes("GROUP_NAME_EXISTS")) {
        setError("A group with this name already exists.");
      } else if (message.includes("GROUP_NAME_REQUIRED")) {
        setError("Please enter a group name.");
      } else {
        setError(message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Dialog open={open} onClose={onClose} size="sm">
        <DialogHeader>
          <DialogTitle>New Group</DialogTitle>
          <DialogDescription>
            Configure the name for your new group.
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="gap-2 pt-0">
          <Input
            label="Group name"
            value={name}
            placeholder="production"
            className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void handleCreate();
              }
            }}
          />
          <p class="text-xs text-slate-500">
            Groups help you organize connections on the main screen.
          </p>
        </DialogContent>
        <DialogFooter className="pt-1">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="default"
            loading={saving}
            onClick={() => void handleCreate()}
          >
            {saving ? "Creating..." : "Create Group"}
          </Button>
        </DialogFooter>
      </Dialog>

      {error ? (
        <ErrorDialog open={true} error={error} onClose={() => setError(null)} />
      ) : null}
    </>
  );
}
