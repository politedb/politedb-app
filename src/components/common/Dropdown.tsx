import { JSX } from "preact";
import { useState } from "preact/hooks";
import type { PopoverPosition } from "react-tiny-popover";
import { Popover } from "./Popover";
import { cn } from "src/utils/cn";
import { ReactNode } from "preact/compat";

export type DropdownItemConfig = {
  key?: string;
  label: ReactNode;
  icon?: JSX.Element;
  disabled?: boolean;
  rightSlot?: JSX.Element;
  separatorBefore?: boolean;
  className?: string;
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
  containerClassName?: string;
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
    containerClassName,
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
      containerClassName={cn(
        positions.includes("top") && "translate-y-1!",
        positions.includes("bottom") && "-translate-y-1!",
        containerClassName
      )}
      content={
        <div
          class={cn(
            widthClassName,
            "overflow-hidden rounded-2xl border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700"
          )}
        >
          {items.map((item, idx) => (
            <div key={item.key ?? `${item.label}-${idx}`}>
              {item.separatorBefore ? (
                <div class="my-1 h-px bg-slate-100" />
              ) : null}
              <button
                type="button"
                disabled={item.disabled}
                class={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-slate-700",
                  item.disabled
                    ? "cursor-not-allowed opacity-58"
                    : "hover:bg-slate-50",
                  item.className,
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
                <span class="min-w-0 flex-1">{item.label}</span>
                {item.rightSlot ? (
                  <span class="shrink-0 text-slate-500">{item.rightSlot}</span>
                ) : null}
              </button>
            </div>
          ))}
        </div>
      }
    >
      {trigger}
    </Popover>
  );
}
