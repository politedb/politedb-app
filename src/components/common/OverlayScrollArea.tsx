import type { ComponentChildren, JSX, RefObject } from "preact";
import { useCallback, useEffect, useRef } from "preact/hooks";
import { cn } from "src/utils/cn";

const TRACK_INSET = 3;
const MIN_THUMB_SIZE = 32;

type ScrollAxis = "horizontal" | "vertical";

type ScrollMetrics = {
  maxScroll: number;
  thumbSize: number;
  thumbTravel: number;
};

function getScrollMetrics(
  scroller: HTMLElement,
  axis: ScrollAxis
): ScrollMetrics | null {
  const viewportSize =
    axis === "vertical" ? scroller.clientHeight : scroller.clientWidth;
  const contentSize =
    axis === "vertical" ? scroller.scrollHeight : scroller.scrollWidth;
  const maxScroll = contentSize - viewportSize;
  if (maxScroll <= 1) return null;

  const trackSize = Math.max(0, viewportSize - TRACK_INSET * 2);
  const thumbSize = Math.min(
    trackSize,
    Math.max(MIN_THUMB_SIZE, (trackSize * viewportSize) / contentSize)
  );

  return {
    maxScroll,
    thumbSize,
    thumbTravel: Math.max(0, trackSize - thumbSize),
  };
}

export function OverlayScrollbars({
  scrollerRef,
  horizontal = false,
  vertical = true,
}: {
  scrollerRef: RefObject<HTMLElement>;
  horizontal?: boolean;
  vertical?: boolean;
}) {
  const horizontalThumbRef = useRef<HTMLDivElement>(null);
  const verticalThumbRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<number | null>(null);
  const dragRef = useRef<{
    axis: ScrollAxis;
    pointerId: number;
    startPointer: number;
    startScroll: number;
  } | null>(null);

  const updateAxis = useCallback(
    (axis: ScrollAxis, thumb: HTMLDivElement | null) => {
      const scroller = scrollerRef.current;
      if (!scroller || !thumb) return;

      const metrics = getScrollMetrics(scroller, axis);
      if (!metrics) {
        thumb.style.opacity = "0";
        thumb.style.pointerEvents = "none";
        return;
      }

      const scrollPosition =
        axis === "vertical" ? scroller.scrollTop : scroller.scrollLeft;
      const thumbPosition =
        TRACK_INSET +
        (scrollPosition / metrics.maxScroll) * metrics.thumbTravel;

      if (axis === "vertical") {
        thumb.style.height = `${metrics.thumbSize}px`;
        thumb.style.transform = `translateY(${thumbPosition}px)`;
      } else {
        thumb.style.width = `${metrics.thumbSize}px`;
        thumb.style.transform = `translateX(${thumbPosition}px)`;
      }
      thumb.style.opacity = "1";
      thumb.style.pointerEvents = "auto";
    },
    [scrollerRef]
  );

  const updateThumbs = useCallback(() => {
    if (vertical) updateAxis("vertical", verticalThumbRef.current);
    if (horizontal) updateAxis("horizontal", horizontalThumbRef.current);
  }, [horizontal, updateAxis, vertical]);

  const scheduleThumbUpdate = useCallback(() => {
    if (frameRef.current !== null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      updateThumbs();
    });
  }, [updateThumbs]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(updateThumbs);
    const observeSize = () => {
      resizeObserver?.disconnect();
      resizeObserver?.observe(scroller);
      Array.from(scroller.children).forEach((child) =>
        resizeObserver?.observe(child)
      );
      updateThumbs();
    };
    const mutationObserver = new MutationObserver(observeSize);

    observeSize();
    mutationObserver.observe(scroller, { childList: true });
    scroller.addEventListener("scroll", scheduleThumbUpdate, {
      passive: true,
    });
    window.addEventListener("resize", scheduleThumbUpdate, { passive: true });

    return () => {
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      scroller.removeEventListener("scroll", scheduleThumbUpdate);
      window.removeEventListener("resize", scheduleThumbUpdate);
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, [scheduleThumbUpdate, scrollerRef, updateThumbs]);

  const handlePointerDown =
    (axis: ScrollAxis) => (event: JSX.TargetedPointerEvent<HTMLDivElement>) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;

      event.preventDefault();
      event.stopPropagation();
      dragRef.current = {
        axis,
        pointerId: event.pointerId,
        startPointer: axis === "vertical" ? event.clientY : event.clientX,
        startScroll:
          axis === "vertical" ? scroller.scrollTop : scroller.scrollLeft,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    };

  const handlePointerMove = (
    event: JSX.TargetedPointerEvent<HTMLDivElement>
  ) => {
    const drag = dragRef.current;
    const scroller = scrollerRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !scroller) return;

    const metrics = getScrollMetrics(scroller, drag.axis);
    if (!metrics || metrics.thumbTravel === 0) return;

    const pointer = drag.axis === "vertical" ? event.clientY : event.clientX;
    const nextScroll =
      drag.startScroll +
      ((pointer - drag.startPointer) / metrics.thumbTravel) * metrics.maxScroll;

    if (drag.axis === "vertical") scroller.scrollTop = nextScroll;
    else scroller.scrollLeft = nextScroll;
  };

  const handlePointerEnd = (
    event: JSX.TargetedPointerEvent<HTMLDivElement>
  ) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  return (
    <>
      {vertical && (
        <div
          ref={verticalThumbRef}
          class="absolute top-0 right-0.5 z-50 w-1.5 touch-none rounded-full bg-black/20 opacity-0 transition-colors hover:bg-black/30"
          onPointerDown={handlePointerDown("vertical")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        />
      )}
      {horizontal && (
        <div
          ref={horizontalThumbRef}
          class="absolute bottom-0.5 left-0 z-50 h-1.5 touch-none rounded-full bg-black/20 opacity-0 transition-colors hover:bg-black/30"
          onPointerDown={handlePointerDown("horizontal")}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        />
      )}
    </>
  );
}

export function OverlayScrollArea({
  children,
  className,
  contentClassName,
  dataScrollRoot = false,
  horizontal = false,
  vertical = true,
}: {
  children: ComponentChildren;
  className?: string;
  contentClassName?: string;
  dataScrollRoot?: boolean;
  horizontal?: boolean;
  vertical?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);

  return (
    <div class={cn("relative grid min-h-0 min-w-0 overflow-hidden", className)}>
      <div
        ref={scrollerRef}
        class={cn(
          "no-scrollbar min-h-0 min-w-0 [grid-area:1/1]",
          horizontal && vertical
            ? "overflow-auto"
            : horizontal
              ? "overflow-x-auto overflow-y-hidden"
              : "overflow-x-hidden overflow-y-auto"
        )}
        data-scroll-root={dataScrollRoot || undefined}
      >
        <div class={contentClassName}>{children}</div>
      </div>
      <OverlayScrollbars
        scrollerRef={scrollerRef}
        horizontal={horizontal}
        vertical={vertical}
      />
    </div>
  );
}
