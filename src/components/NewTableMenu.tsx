import { MenuDropdown, MenuDropdownItem } from "./common/MenuDropdown";
import { Table, Eye } from "./icons";
import { cn } from "../utils/cn";
import { Button } from "./common/Button";

export interface Props {
  onNewTable?: () => void;
  onNewSchema?: () => void;
  className?: string;
}

export function NewTableMenu({ onNewTable, onNewSchema, className }: Props) {
  const items: MenuDropdownItem[] = [
    {
      label: "New Table",
      onClick: () => onNewTable?.(),
      icon: <Table className="size-4 text-slate-500" />,
    },
    {
      label: "New View",
      onClick: () => onNewSchema?.(),
      icon: <Eye className="size-4 text-slate-500" />,
    },
  ];

  return (
    <MenuDropdown
      items={items}
      trigger={
        <Button
          variant="outline"
          className={cn(
            "h-8 w-8 p-3",
            "border-neutral-300 bg-white text-neutral-800"
          )}
          title="New"
        >
          +
        </Button>
      }
      align="top"
      width={220}
      className={className}
    />
  );
}
