import { useCallback, useRef, useState } from "preact/hooks";

const MIN_SPIN_MS = 400;

/** Runs refresh and exposes spinning state for toolbar icon + keyboard shortcut. */
export function useRefreshTrigger(onRefresh?: () => void | Promise<void>) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const inFlightRef = useRef(false);
  const onRefreshRef = useRef(onRefresh);

  onRefreshRef.current = onRefresh;

  const triggerRefresh = useCallback((): Promise<void> => {
    const refresh = onRefreshRef.current;
    if (!refresh || inFlightRef.current) return Promise.resolve();

    inFlightRef.current = true;
    setIsRefreshing(true);

    const startedAt = Date.now();

    return new Promise<void>((resolve) => {
      void Promise.resolve()
        .then(() => refresh())
        .finally(() => {
          const remaining = MIN_SPIN_MS - (Date.now() - startedAt);
          const finish = () => {
            inFlightRef.current = false;
            setIsRefreshing(false);
            resolve();
          };
          if (remaining > 0) {
            window.setTimeout(finish, remaining);
          } else {
            finish();
          }
        });
    });
  }, []);

  return { isRefreshing, triggerRefresh };
}
