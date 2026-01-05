import { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

export function Tooltip(props: {
  content: JSX.Element | string;
  children: JSX.Element;
  width?: number;
  align?: "left" | "right" | "center";
  delay?: number; // ms
}) {
  const { content, children, width = 320, align = "left", delay = 200 } = props;

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
      // auto flip
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

  return (
    <div
      ref={wrapperRef}
      class="relative inline-block w-full"
      onMouseEnter={onEnter}
      onMouseLeave={onLeave}
      onMouseDown={onLeave}
      onFocus={onLeave}
    >
      {children}

      {open ? (
        <div
          class={`pointer-events-none absolute top-full z-50 mt-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-xs leading-snug text-slate-700 shadow-lg ${alignCls} `}
          style={{ width }}
        >
          {content}
        </div>
      ) : null}
    </div>
  );
}
