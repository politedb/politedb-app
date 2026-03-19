import { MenuDropdown, MenuDropdownItem } from "../common/MenuDropdown";
import { Table, Schema } from "../icons";
import { cn } from "src/utils/cn";
import { Button } from "../common/Button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../common/Dialog";
import { useCallback, useState } from "preact/hooks";
import { Input } from "../form/Input";
import { useCreateSchemaTable } from "src/hooks/useCreateSchemaTable";

interface Props {
  onOpenNewTable?: () => void;
  enableNewSchema?: boolean;
  className?: string;
  disabled?: boolean;
}

export function NewTableMenu({
  onOpenNewTable,
  enableNewSchema = true,
  className,
  disabled = false,
}: Props) {
  const [openSchema, setOpenSchema] = useState(false);

  const items: MenuDropdownItem[] = [
    {
      label: "New Table",
      onClick: () => onOpenNewTable?.(),
      icon: <Table className="size-4 text-neutral-600" />,
    },
    {
      label: "New Schema",
      onClick: () => setOpenSchema(true),
      icon: <Schema className="size-4 text-neutral-600" />,
      hidden: !enableNewSchema,
    },
  ];

  return (
    <>
      <MenuDropdown
        items={items}
        trigger={
          <Button
            variant="outline"
            className={cn(
              "size-6 p-2",
              "border-neutral-300 bg-white text-neutral-800"
            )}
            title={disabled ? "Not supported" : "New"}
            disabled={disabled}
          >
            +
          </Button>
        }
        align="top"
        width={220}
        className={className}
      />

      {enableNewSchema && openSchema && (
        <NewSchemaDialog
          open={openSchema}
          onClose={() => setOpenSchema(false)}
        />
      )}
    </>
  );
}

function NewSchemaDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [schemaName, setSchemaName] = useState("");
  const { createSchema, busy, error, setError } = useCreateSchemaTable();

  const handleClose = useCallback(() => {
    onClose();
    setError(null);
    setSchemaName("");
  }, [onClose, setError, setSchemaName]);

  const handleCreateSchema = useCallback(async () => {
    if (!schemaName) return;
    await createSchema(schemaName, handleClose);
  }, [schemaName, createSchema, handleClose]);

  return (
    <Dialog open={open} showCloseButton={false} onClose={handleClose} size="sm">
      <DialogContent>
        <DialogHeader className="px-0 py-0">
          <DialogTitle>Create new schema</DialogTitle>
          <DialogDescription>
            Enter a name for your new schema
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Input
            placeholder="Schema name..."
            value={schemaName}
            onInput={(e) => setSchemaName(e.currentTarget.value)}
            className="w-full rounded-lg border border-neutral-200 p-2 text-sm"
          />
          {error && <div className="text-xs text-red-500">{error}</div>}
        </div>
      </DialogContent>
      <DialogFooter className="justify-center">
        <Button variant="outline" onClick={handleClose}>
          Cancel
        </Button>
        <Button
          className="border border-blue-500"
          variant="default"
          onClick={handleCreateSchema}
          disabled={!schemaName || busy}
          loading={busy}
        >
          Create
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
