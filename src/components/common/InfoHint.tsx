import { useEffect, useId, useRef, useState } from "preact/hooks";
import { createPortal } from "preact/compat";
import { cn } from "src/utils/cn";

const POPOVER_WIDTH = 280;
const VIEWPORT_MARGIN = 8;

type Position = { left: number; top?: number; bottom?: number };

function popoverPosition(anchor: DOMRect): Position {
  const left = Math.min(
    Math.max(
      VIEWPORT_MARGIN,
      anchor.left + anchor.width / 2 - POPOVER_WIDTH / 2
    ),
    window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN
  );
  // Prefer below; flip above when the anchor sits in the lower half.
  if (anchor.bottom > window.innerHeight / 2) {
    return { left, bottom: window.innerHeight - anchor.top + 6 };
  }
  return { left, top: anchor.bottom + 6 };
}

/**
 * Small ⓘ marker for caveats and jargon. The text shows on hover and on
 * keyboard focus (Escape hides it), portaled so the scrolling overview never
 * clips it, and is the marker's accessible description.
 */
export function InfoHint(props: { text: string; className?: string }) {
  const id = useId();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<Position | null>(null);

  const show = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setPosition(popoverPosition(rect));
  };
  const hide = () => setPosition(null);

  // A scroll moves the anchor away from a fixed popover; hide instead of drifting.
  // Escape hides an open hint whether it opened by hover or focus: the capture
  // listener runs before the Dialog's bubbling document listener and consumes
  // only this Escape, so a second press still closes the dialog.
  useEffect(() => {
    if (!position) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      hide();
    };
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [position]);

  return (
    <>
      <span
        ref={anchorRef}
        role="img"
        tabIndex={0}
        aria-label="More info"
        aria-describedby={id}
        class={cn(
          "inline-flex size-3.5 shrink-0 cursor-help items-center justify-center rounded-full text-neutral-400 outline-none hover:text-neutral-600 focus-visible:ring-2 focus-visible:ring-neutral-400 dark:text-neutral-500 dark:hover:text-neutral-300",
          props.className
        )}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          class="size-3.5"
          aria-hidden="true"
        >
          <circle
            cx="8"
            cy="8"
            r="6.5"
            stroke="currentColor"
            stroke-width="1.3"
          />
          <path
            d="M8 7.2v3.6"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
          <circle cx="8" cy="5" r="0.85" fill="currentColor" />
        </svg>
      </span>
      {/* Always in the DOM so aria-describedby resolves; visible only while shown. */}
      {createPortal(
        <div
          id={id}
          role="tooltip"
          hidden={!position}
          class="pointer-events-none fixed z-[1100] rounded-lg border border-neutral-200 bg-white px-3 py-2 text-xs leading-snug text-neutral-700 shadow-lg dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200"
          style={{
            width: POPOVER_WIDTH,
            left: position?.left,
            top: position?.top,
            bottom: position?.bottom,
          }}
        >
          {props.text}
        </div>,
        document.body
      )}
    </>
  );
}
