import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";

type Direction = "vertical" | "horizontal";

type Props = {
  first: preact.ComponentChildren;
  second: preact.ComponentChildren;
  direction: Direction;

  /** initial ratio of first pane (0..1) */
  initialRatio?: number;

  /**
   * Which pane should try to keep its pixel size when the
   * container (window) is resized.
   *
   * - "first"  → keep first pane size (default)
   * - "second" → keep second pane size (bottom/right panes)
   */
  fixedPaneOnResize?: "first" | "second";

  minFirstPx?: number;
  minSecondPx?: number;

  // hit area thickness (keep >= 6 for usability)
  splitterPx?: number;

  className?: string;
};

export function SplitPane(props: Props) {
  const {
    first,
    second,
    direction,
    initialRatio = 0.5,
    fixedPaneOnResize = "first",
    minFirstPx = 120,
    minSecondPx = 120,
    splitterPx = 8,
    className,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const sizeRef = useRef<number | null>(null);
  const lastTotalRef = useRef<number | null>(null);

  const [dragging, setDragging] = useState(false);
  const [, force] = useState(0);

  const isVertical = direction === "vertical";

  const getContainerSize = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    return isVertical ? el.clientHeight : el.clientWidth;
  }, [isVertical]);

  const clampSize = useCallback(
    (px: number, total: number) => {
      const maxFirst = total - splitterPx - Math.max(minSecondPx, 0);
      return Math.min(Math.max(px, minFirstPx), maxFirst);
    },
    [minFirstPx, minSecondPx, splitterPx]
  );

  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Initialize synchronously to avoid first-paint flicker
    // (second pane taking full size before observer callback runs).
    const initialTotal = getContainerSize();
    if (initialTotal && sizeRef.current == null) {
      sizeRef.current = clampSize(
        Math.floor(initialTotal * initialRatio),
        initialTotal
      );
      lastTotalRef.current = initialTotal;
      force((v) => v + 1);
    }

    const ro = new ResizeObserver(() => {
      const total = getContainerSize();
      if (!total) return;

      if (sizeRef.current == null) {
        sizeRef.current = clampSize(Math.floor(total * initialRatio), total);
        lastTotalRef.current = total;
        force((v) => v + 1);
      } else {
        // Adjust size when the container changes:
        // - if fixedPaneOnResize === "first", keep first pane size (old behavior)
        // - if fixedPaneOnResize === "second", keep second pane size in pixels
        const prevTotal = lastTotalRef.current ?? total;
        let nextFirst = sizeRef.current;

        if (fixedPaneOnResize === "second") {
          const prevSecond = Math.max(
            0,
            prevTotal - splitterPx - sizeRef.current
          );
          const desiredFirst = total - splitterPx - prevSecond;
          nextFirst = desiredFirst;
        }

        const clamped = clampSize(nextFirst, total);
        if (clamped !== sizeRef.current) {
          sizeRef.current = clamped;
          force((v) => v + 1);
        }

        if (prevTotal !== total) {
          lastTotalRef.current = total;
        }
      }
    });

    ro.observe(el);
    return () => ro.disconnect();
  }, [
    initialRatio,
    splitterPx,
    minFirstPx,
    minSecondPx,
    fixedPaneOnResize,
    getContainerSize,
    clampSize,
  ]);

  function onPointerDown(e: PointerEvent) {
    e.preventDefault();
    draggingRef.current = true;
    setDragging(true);

    // nicer UX: global cursor while dragging
    document.body.style.cursor = isVertical ? "row-resize" : "col-resize";
    document.body.style.userSelect = "none";

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!draggingRef.current) return;

    const el = containerRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const total = getContainerSize();
    const offset = isVertical ? e.clientY - rect.top : e.clientX - rect.left;

    const next = clampSize(offset, total);
    if (next !== sizeRef.current) {
      sizeRef.current = next;
      force((v) => v + 1);
    }
  }

  function onPointerUp(e: PointerEvent) {
    draggingRef.current = false;
    setDragging(false);

    document.body.style.cursor = "";
    document.body.style.userSelect = "";

    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {}
  }

  const firstSize = sizeRef.current ?? 0;

  const firstStyle = isVertical
    ? { height: `${firstSize}px` }
    : { width: `${firstSize}px` };

  // Hit area stays thick, visual line stays thin
  const splitterStyle = isVertical
    ? { height: `${splitterPx}px` }
    : { width: `${splitterPx}px` };

  const splitterCursor = isVertical ? "cursor-row-resize" : "cursor-col-resize";

  return (
    <div
      ref={containerRef}
      class={[
        "flex h-full min-h-0 w-full min-w-0 overflow-hidden",
        isVertical ? "flex-col" : "flex-row",
        className,
      ].join(" ")}
    >
      {/* First pane */}
      <div class="flex min-h-0 min-w-0 shrink-0 flex-col" style={firstStyle}>
        {first}
      </div>

      {/* Splitter (thick hit area, thin line) */}
      <div
        class={["relative shrink-0 select-none", splitterCursor].join(" ")}
        style={splitterStyle}
        onPointerDown={onPointerDown as any}
        onPointerMove={onPointerMove as any}
        onPointerUp={onPointerUp as any}
      >
        {/* thin line */}
        <div
          class={[
            "pointer-events-none absolute",
            // center line
            isVertical
              ? "top-1/2 right-0 left-0 h-px -translate-y-1/2"
              : "top-0 bottom-0 left-1/2 w-px -translate-x-1/2",
            // color states
            dragging ? "bg-blue-500" : "bg-neutral-200",
            // subtle hover via parent group is harder; do it with opacity overlay
          ].join(" ")}
        />

        {/* subtle hover affordance (still thin, but visible) */}
        <div
          class={[
            "pointer-events-none absolute inset-0",
            dragging ? "bg-blue-500/5" : "hover:bg-neutral-500/5",
          ].join(" ")}
        />
      </div>

      {/* Second pane */}
      <div class="min-h-0 min-w-0 flex-1 overflow-auto">{second}</div>
    </div>
  );
}
