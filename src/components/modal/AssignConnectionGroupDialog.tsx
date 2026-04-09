import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { Select } from "src/components/common/Select";
import type { ConnectionGroup } from "src/stores/connectionGroups";
import { useEffect, useState } from "preact/hooks";

export function AssignConnectionGroupDialog(props: {
  open: boolean;
  onClose: () => void;
  connectionLabel: string;
  groups: ConnectionGroup[];
  selectedGroupId?: string;
  onSave: (groupId?: string) => void | Promise<void>;
}) {
  const { open, onClose, connectionLabel, groups, selectedGroupId, onSave } =
    props;
  const [value, setValue] = useState(selectedGroupId ?? "");

  useEffect(() => {
    if (!open) return;
    setValue(selectedGroupId ?? "");
  }, [open, selectedGroupId]);

  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DialogHeader>
        <DialogTitle>Move Connection To Group</DialogTitle>
      </DialogHeader>
      <DialogContent className="gap-2 pt-0">
        <p class="text-sm text-slate-600">
          Choose a group for <span class="font-semibold">{connectionLabel}</span>.
        </p>

        <Select
          value={value}
          onChange={(e) => setValue(e.currentTarget.value)}
          className="h-11"
        >
          <option value="">Ungrouped</option>
          {groups.map((group) => (
            <option key={group.id} value={group.id}>
              {group.name}
            </option>
          ))}
        </Select>
      </DialogContent>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button
          variant="default"
          onClick={() => void onSave(value || undefined)}
        >
          Save
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
