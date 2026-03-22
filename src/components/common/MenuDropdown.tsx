import { JSX } from "preact";
import { useState, useRef } from "preact/hooks";
import { MenuPopover, MenuItem } from "./MenuPopover";
import { cn } from "src/utils/cn";

export interface MenuDropdownItem {
  label: string;
  onClick: () => void;
  icon?: JSX.Element;
  danger?: boolean;
  disabled?: boolean;
  hidden?: boolean;
  right?: JSX.Element;
  separator?: boolean; // Add separator after this item
}

interface MenuDropdownProps {
  items: MenuDropdownItem[];
  trigger: JSX.Element | ((open: boolean) => JSX.Element);
  align?: "left" | "right" | "top";
  width?: number;
  className?: string;
  onOpenChange?: (open: boolean) => void;
}

export function MenuDropdown({
  items,
  trigger,
  align = "right",
  width = 220,
  className,
  onOpenChange,
}: MenuDropdownProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);

  const handleOpenChange = (newOpen: boolean) => {
    setOpen(newOpen);
    onOpenChange?.(newOpen);
  };

  const handleClose = () => {
    handleOpenChange(false);
  };

  const triggerElement =
    typeof trigger === "function" ? trigger(open) : trigger;

  return (
    <div className={cn("relative", className)}>
      <div ref={triggerRef} onClick={() => handleOpenChange(!open)}>
        {triggerElement}
      </div>

      <MenuPopover
        open={open}
        onClose={handleClose}
        anchorEl={triggerRef.current}
        align={align}
        width={width}
      >
        <div role="menu" className="py-1">
          {items.map((item, index) => {
            if (item?.hidden) return null;
            const showSeparator = item.separator && index > 0;

            return (
              <div key={index}>
                {showSeparator && (
                  <div className="my-1 border-t border-slate-200" />
                )}
                <MenuItem
                  onClick={() => {
                    if (!item.disabled) {
                      item.onClick();
                      handleClose();
                    }
                  }}
                  danger={item.danger}
                  disabled={item.disabled}
                  right={item.right}
                >
                  <span className="flex items-center gap-2">
                    {item.icon && <span className="shrink-0">{item.icon}</span>}
                    <span>{item.label}</span>
                  </span>
                </MenuItem>
              </div>
            );
          })}
        </div>
      </MenuPopover>
    </div>
  );
}
