import { JSX } from "preact";
import { useState } from "preact/hooks";
import type { PopoverPosition } from "react-tiny-popover";
import { Popover } from "./Popover";
import { cn } from "src/utils/cn";

export type DropdownItemConfig = {
  key?: string;
  label: string;
  icon?: JSX.Element;
  disabled?: boolean;
  onSelect?: () => void;
};

export function Dropdown(props: {
  trigger: JSX.Element;
  items: DropdownItemConfig[];
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  positions?: PopoverPosition[];
  align?: "start" | "center" | "end";
  padding?: number;
  widthClassName?: string;
  contentClassName?: string;
  itemClassName?: string;
}) {
  const {
    trigger,
    items,
    open: controlledOpen,
    onOpenChange,
    positions = ["bottom"],
    align = "start",
    padding = 10,
    widthClassName = "w-56",
    contentClassName,
    itemClassName,
  } = props;

  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;

  function setOpen(next: boolean) {
    if (controlledOpen === undefined) {
      setUncontrolledOpen(next);
    }
    onOpenChange?.(next);
  }

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      positions={positions}
      align={align}
      padding={padding}
      showArrow={false}
      contentClassName={cn("rounded-2xl", contentClassName)}
      containerClassName="-translate-y-1!"
      content={
        <div
          class={cn(
            widthClassName,
            "overflow-hidden rounded-2xl border border-slate-200 bg-white p-1 shadow-xl"
          )}
        >
          {items.map((item, idx) => (
            <button
              key={item.key ?? `${item.label}-${idx}`}
              type="button"
              disabled={item.disabled}
              class={cn(
                "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700",
                item.disabled
                  ? "cursor-not-allowed opacity-50"
                  : "hover:bg-slate-50",
                itemClassName
              )}
              onClick={() => {
                if (item.disabled) return;
                setOpen(false);
                item.onSelect?.();
              }}
            >
              {item.icon ? (
                <span class="shrink-0 text-slate-500">{item.icon}</span>
              ) : null}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      }
    >
      {trigger}
    </Popover>
  );
}
