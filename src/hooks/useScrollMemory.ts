import { useEffect } from "preact/hooks";

/** How long a restore keeps waiting for content to grow. */
const RESTORE_TIMEOUT_MS = 5000;
/** Interactions that mean the user scrolls on their own. */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "keydown", "pointerdown"];

/**
 * Remembers a scroller's position per page and puts it back when the page is
 * shown again.
 *
 * - The position is saved on every user scroll, but only while `isCurrent(key)`
 *   holds: after switching pages, the browser may clamp the shared scroller
 *   to the new, shorter content, and that must not overwrite the old page.
 * - Restoring waits for content to grow (lists load, History pages in more
 *   rows as it nears the end) and stops once the target is reached, after a
 *   timeout, or as soon as the user scrolls themselves. Scroll events caused by
 *   restoring are not saved, so a half-loaded page never replaces the target.
 */
export function useScrollMemory(options: {
  getScroller: () => HTMLElement | null | undefined;
  key: string;
  read: (key: string) => number;
  write: (key: string, top: number) => void;
  isCurrent: (key: string) => boolean;
}) {
  const { key } = options;

  useEffect(() => {
    const scroller = options.getScroller();
    if (!scroller) return;
    const target = options.read(key);
    let restoring = target > 0;
    // Interactions are watched on the wrapper too, in the capture phase: the
    // overlay scrollbar sits next to the scroller and stops propagation, and
    // dragging it must cancel restoring like any other user scroll.
    const surface = scroller.parentElement ?? scroller;

    const content = scroller.firstElementChild;
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => apply());
    const timer = window.setTimeout(() => stop(), RESTORE_TIMEOUT_MS);

    function stop() {
      restoring = false;
      observer?.disconnect();
      window.clearTimeout(timer);
      for (const type of USER_SCROLL_EVENTS)
        surface.removeEventListener(type, stop, { capture: true });
    }

    function apply() {
      if (!restoring) return;
      scroller!.scrollTop = target;
      if (Math.abs(scroller!.scrollTop - target) < 1) stop();
    }

    const onScroll = () => {
      if (restoring || !options.isCurrent(key)) return;
      options.write(key, scroller.scrollTop);
    };

    if (restoring) {
      for (const type of USER_SCROLL_EVENTS)
        surface.addEventListener(type, stop, { capture: true, passive: true });
      if (content) observer?.observe(content);
      apply();
    } else {
      // The scroller is shared between pages: a page saved at the top must not
      // open where the previous page was left.
      stop();
      scroller.scrollTop = 0;
    }
    scroller.addEventListener("scroll", onScroll, { passive: true });

    return () => {
      stop();
      scroller.removeEventListener("scroll", onScroll);
    };
    // Re-run only for another page; the callbacks read live state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
