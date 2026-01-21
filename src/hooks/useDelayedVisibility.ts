import { useEffect, useRef, useState } from "preact/hooks";

type DelayOpts = {
  showDelayMs?: number; // default 200
  minShowMs?: number; // default 450
};

export function useDelayedVisibility(
  shouldShow: boolean,
  opts: DelayOpts = {}
) {
  const showDelayMs = opts.showDelayMs ?? 200;
  const minShowMs = opts.minShowMs ?? 450;

  const [visible, setVisible] = useState(false);

  const showTimerRef = useRef<number | null>(null);
  const hideTimerRef = useRef<number | null>(null);
  const shownAtRef = useRef<number>(0);

  useEffect(() => {
    const clearTimers = () => {
      if (showTimerRef.current != null) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      if (hideTimerRef.current != null) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    clearTimers();

    if (shouldShow) {
      // delay show
      showTimerRef.current = window.setTimeout(() => {
        shownAtRef.current = Date.now();
        setVisible(true);
      }, showDelayMs);

      return () => clearTimers();
    }

    // should hide
    if (!visible) return () => clearTimers();

    const elapsed = Date.now() - shownAtRef.current;
    const remaining = Math.max(0, minShowMs - elapsed);

    hideTimerRef.current = window.setTimeout(() => {
      setVisible(false);
    }, remaining);

    return () => clearTimers();
  }, [shouldShow, showDelayMs, minShowMs, visible]);

  return visible;
}
