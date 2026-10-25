import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

const DEFAULT_PAGE_SIZE = 40;

export function useInfiniteScroll<T>(
  items: T[],
  opts?: {
    pageSize?: number;
    resetKey?: string | number;
    /** An item that must be shown even past the loaded pages (the open one). */
    keepVisibleIndex?: number;
  }
) {
  const pageSize = opts?.pageSize ?? DEFAULT_PAGE_SIZE;
  const resetKey = opts?.resetKey ?? items.length;

  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [sentinel, setSentinel] = useState<HTMLDivElement | null>(null);
  const sentinelRef = useCallback((node: HTMLDivElement | null) => {
    setSentinel(node);
  }, []);

  useEffect(() => {
    setVisibleCount(pageSize);
  }, [resetKey, pageSize]);

  const shownCount = Math.max(visibleCount, (opts?.keepVisibleIndex ?? -1) + 1);
  const visibleItems = useMemo(
    () => items.slice(0, shownCount),
    [items, shownCount]
  );

  const hasMore = shownCount < items.length;

  const loadMore = useCallback(() => {
    setVisibleCount((current) =>
      Math.min(Math.max(current, shownCount) + pageSize, items.length)
    );
  }, [items.length, pageSize, shownCount]);

  useEffect(() => {
    if (!sentinel || !hasMore) return;

    const scrollRoot =
      (sentinel.closest("[data-scroll-root]") as HTMLElement | null) ?? null;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadMore();
      },
      { root: scrollRoot, rootMargin: "160px", threshold: 0 }
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [hasMore, loadMore, sentinel, visibleCount]);

  return {
    visibleItems,
    sentinelRef,
    hasMore,
    visibleCount: shownCount,
    totalCount: items.length,
  };
}
