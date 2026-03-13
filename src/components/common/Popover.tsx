import { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import {
  Popover as TinyPopover,
  PopoverPosition,
  PopoverState,
} from "react-tiny-popover";
import { cn } from "src/utils/cn";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  content: JSX.Element;
  children: JSX.Element;
  positions?: PopoverPosition[];
  align?: "start" | "center" | "end";
  padding?: number;
  showArrow?: boolean;
  contentClassName?: string;
  containerClassName?: string;
}

const CLOSE_TRANSITION_MS = 140;

export function Popover({
  open,
  onOpenChange,
  content,
  children,
  positions = ["top", "bottom"],
  align = "center",
  padding = 14,
  showArrow = true,
  contentClassName,
  containerClassName,
}: Props) {
  const closeTimerRef = useRef<number | null>(null);
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }

    if (open) {
      setMounted(true);
      requestAnimationFrame(() => setVisible(true));
      return;
    }

    setVisible(false);
    closeTimerRef.current = window.setTimeout(() => {
      setMounted(false);
    }, CLOSE_TRANSITION_MS);

    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, [open]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
      }
    };
  }, []);

  return (
    <TinyPopover
      isOpen={mounted}
      positions={positions}
      align={align}
      padding={padding}
      onClickOutside={() => onOpenChange(false)}
      containerClassName={cn("z-[1000]", containerClassName)}
      content={({ position }: PopoverState) => {
        return (
          <div class="relative">
            <div
              class={cn(
                "transition-all duration-150 ease-out",
                visible
                  ? "translate-y-0 scale-100 opacity-100"
                  : position === "top"
                    ? "translate-y-1 scale-[0.98] opacity-0"
                    : "-translate-y-1 scale-[0.98] opacity-0",
                contentClassName
              )}
            >
              {content}
            </div>
            {showArrow ? (
              <div
                class={cn(
                  "pointer-events-none absolute size-4 rotate-45 border-r border-b border-neutral-200 bg-white transition-all duration-150 ease-out",
                  visible ? "opacity-100" : "opacity-0",
                  position === "top" ? "-bottom-2" : "-top-2"
                )}
                style={{ left: "calc(50% - 8px)" }}
              />
            ) : null}
          </div>
        );
      }}
    >
      {children}
    </TinyPopover>
  );
}
