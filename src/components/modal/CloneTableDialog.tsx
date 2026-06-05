import { useCallback, useEffect, useState } from "preact/hooks";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Input } from "src/components/common/Input";
import { ErrorDialog } from "./ErrorDialog";
import { Checkbox } from "src/components/common/Checkbox";

interface Props {
  open: boolean;
  sourceTableName: string;
  showCopyDataOption?: boolean;
  onClose: () => void;
  onConfirm: (newTableName: string, copyData: boolean) => Promise<void>;
}

export function CloneTableDialog({
  open,
  sourceTableName,
  showCopyDataOption = true,
  onClose,
  onConfirm,
}: Props) {
  const [newTableName, setNewTableName] = useState("");
  const [copyData, setCopyData] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNewTableName(`${sourceTableName}_copy`);
    setCopyData(showCopyDataOption);
    setError(null);
  }, [open, sourceTableName, showCopyDataOption]);

  const handleConfirm = useCallback(async () => {
    const name = newTableName.trim();
    if (!name) {
      setError("Enter a table name.");
      return;
    }
    if (name === sourceTableName) {
      setError("New table name must differ from the source table.");
      return;
    }
    setError(null);
    setLoading(true);
    try {
      await onConfirm(name, showCopyDataOption ? copyData : false);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clone failed.");
    } finally {
      setLoading(false);
    }
  }, [
    newTableName,
    sourceTableName,
    showCopyDataOption,
    copyData,
    onConfirm,
    onClose,
  ]);

  return (
    <>
      <Dialog open={open} onClose={onClose} size="md">
        <DialogHeader>
          <DialogTitle>Clone table '{sourceTableName}'</DialogTitle>
          <DialogDescription>
            Create a copy of <strong>{sourceTableName}</strong> in the same
            schema.
          </DialogDescription>
        </DialogHeader>
        <DialogContent className="py-0">
          <div class="space-y-3">
            <Input
              label="New table name"
              value={newTableName}
              onValueChange={setNewTableName}
              placeholder="e.g. my_table_copy"
              className="mb-1 rounded-md border border-neutral-300 px-2 py-1 text-sm"
              disabled={loading}
            />
            {showCopyDataOption && (
              <Checkbox
                checked={copyData}
                onChange={(e) => setCopyData(e.currentTarget.checked)}
                label="Copy table data"
                disabled={loading}
              />
            )}
          </div>
        </DialogContent>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={loading}>
            Cancel
          </Button>
          <Button variant="default" onClick={handleConfirm} disabled={loading}>
            {loading ? "Cloning..." : "Clone"}
          </Button>
        </DialogFooter>
      </Dialog>

      {error && <ErrorDialog open={true} error={error} onClose={onClose} />}
    </>
  );
}
