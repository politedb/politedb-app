import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Button } from "src/components/common/Button";
import { cn } from "src/utils/cn";
import { PoliteDbIcon } from "../icons/PoliteDb";
import { DbeaverIcon } from "../icons/Dbeaver";
import { TablePlusIcon } from "../icons/TablePlus";
import { ConsoleIcon } from "src/components/icons";

export type ImportConnectionSource =
  | "dbeaver"
  | "env"
  | "tableplus"
  | "politedb";

const SOURCES: {
  id: ImportConnectionSource;
  title: string;
  description: string;
  hint: string;
  icon: React.ReactNode;
}[] = [
  {
    id: "env",
    title: "Environment file",
    description:
      "Import database settings or connection URLs from a .env file.",
    hint: "Supports DB_HOST/PORT/USER/PASSWORD/NAME and common database URLs.",
    icon: <ConsoleIcon className="size-full p-2 text-slate-600" />,
  },
  {
    id: "politedb",
    title: "PoliteDB",
    description: "Import a .politedbconnection file exported from PoliteDB.",
    hint: "Use Export for another device… on a connection card.",
    icon: <PoliteDbIcon />,
  },
  {
    id: "dbeaver",
    title: "DBeaver",
    description: "Import from data-sources.json in your DBeaver workspace.",
    hint: "Usually at …/General/.dbeaver/data-sources.json",
    icon: <DbeaverIcon />,
  },
  {
    id: "tableplus",
    title: "TablePlus",
    description:
      "Import from Connections.plist or an exported .tableplusconnection file.",
    hint: "Export from TablePlus, or pick Connections.plist on this Mac.",
    icon: <TablePlusIcon />,
  },
];

export function ImportConnectionSourceDialog(props: {
  open: boolean;
  onClose: () => void;
  onSelect: (source: ImportConnectionSource) => void;
}) {
  const { open, onClose, onSelect } = props;

  return (
    <Dialog open={open} onClose={onClose} size="md">
      <DialogHeader>
        <DialogTitle>Import connections</DialogTitle>
        <DialogDescription>
          Choose where your connections are exported from.
        </DialogDescription>
      </DialogHeader>

      <DialogContent className="grid gap-2 pt-1 sm:grid-cols-1">
        {SOURCES.map((source) => (
          <button
            key={source.id}
            type="button"
            class={cn(
              "flex w-full items-start gap-3 rounded-lg border border-slate-200 bg-white px-3 py-3 text-left",
              "transition hover:border-blue-300 hover:bg-blue-50/40",
              "focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            )}
            onClick={() => onSelect(source.id)}
          >
            <div class="size-12 rounded-xl bg-slate-50 p-1">{source.icon}</div>
            <div class="min-w-0 flex-1 pt-0.5">
              <span class="text-sm font-semibold text-slate-900">
                {source.title}
              </span>
              <span class="mt-0.5 block text-xs text-slate-600">
                {source.description}
              </span>
              <span class="mt-1.5 block text-[11px] text-slate-400">
                {source.hint}
              </span>
            </div>
          </button>
        ))}
      </DialogContent>

      <DialogFooter className="pt-1">
        <Button variant="shadow" className="py-1.5" onClick={onClose}>
          Cancel
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
