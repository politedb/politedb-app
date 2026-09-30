import { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { cn } from "src/utils/cn";

export function Tooltip(props: {
  className?: string;
  content: JSX.Element | string;
  children: JSX.Element;
  width?: number;
  align?: "left" | "right" | "center";
  /** Prefer "top" near dialog bottoms — popover is not portaled and is clipped by overflow. */
  side?: "top" | "bottom";
  delay?: number; // ms
}) {
  const {
    className,
    content,
    children,
    width = 320,
    align = "left",
    side = "bottom",
    delay = 200,
  } = props;

  const [open, setOpen] = useState(false);
  const [realAlign, setRealAlign] = useState<"left" | "right" | "center">(
    align
  );

  const wrapperRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);

  function clearTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  function onEnter() {
    clearTimer();
    timerRef.current = window.setTimeout(() => {
      // auto flip horizontal
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (rect) {
        if (rect.left + width > window.innerWidth - 8) {
          setRealAlign("right");
        } else {
          setRealAlign(align);
        }
      }
      setOpen(true);
    }, delay);
  }

  function onLeave() {
    clearTimer();
    setOpen(false);
  }

  useEffect(() => () => clearTimer(), []);

  const alignCls =
    realAlign === "right"
      ? "right-0"
      : realAlign === "center"
        ? "left-1/2 -translate-x-1/2"
        : "left-0";

  const sideCls = side === "top" ? "bottom-full mb-1" : "top-full mt-1";

  return (
    <div
      ref={wrapperRef}
      class={cn("relative inline-block w-full", className)}
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseDown={onLeave}
      onFocus={onLeave}
    >
      {children}

      {open ? (
        <div
          class={cn(
            "pointer-events-none absolute z-50 rounded-xl",
            "border border-slate-200 bg-white px-3 py-2",
            "text-xs leading-snug text-slate-700 shadow-lg",
            sideCls,
            alignCls
          )}
          style={{ width }}
          role="tooltip"
        >
          {content}
        </div>
      ) : null}
    </div>
  );
}
