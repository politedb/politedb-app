import { useCallback, useRef, useState } from "preact/hooks";

const MIN_SPIN_MS = 400;

/** Runs refresh and exposes spinning state for toolbar icon + keyboard shortcut. */
export function useRefreshTrigger(onRefresh?: () => void | Promise<void>) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const inFlightRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);
  const spinTimerRef = useRef<number | null>(null);

  onRefreshRef.current = onRefresh;

  const clearSpinTimer = () => {
    if (spinTimerRef.current != null) {
      window.clearTimeout(spinTimerRef.current);
      spinTimerRef.current = null;
    }
  };

  const triggerRefresh = useCallback((): Promise<void> => {
    const refresh = onRefreshRef.current;
    if (!refresh || inFlightRef.current) return Promise.resolve();

    inFlightRef.current = true;
    setIsRefreshing(true);
    clearSpinTimer();

    const startedAt = Date.now();

    const finish = (resolve: () => void) => {
      inFlightRef.current = false;
      setIsRefreshing(false);
      spinTimerRef.current = null;
      resolve();
    };

    return new Promise<void>((resolve) => {
      void Promise.resolve()
        .then(() => refresh())
        .catch(() => {
          // Errors must still clear the MenuBar spinner (success/error/cancel).
        })
        .finally(() => {
          const remaining = MIN_SPIN_MS - (Date.now() - startedAt);
          if (remaining > 0) {
            spinTimerRef.current = window.setTimeout(
              () => finish(resolve),
              remaining
            );
          } else {
            finish(resolve);
          }
        });
    });
  }, []);

  return { isRefreshing, triggerRefresh };
}
