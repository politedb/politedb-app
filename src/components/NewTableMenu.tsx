import { MenuDropdown, MenuDropdownItem } from "./common/MenuDropdown";
import { Table, Schema } from "./icons";
import { cn } from "src/utils/cn";
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
      icon: <Table className="size-4 text-neutral-600" />,
    },
    {
      label: "New Schema",
      onClick: () => onNewSchema?.(),
      icon: <Schema className="size-4 text-neutral-600" />,
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
