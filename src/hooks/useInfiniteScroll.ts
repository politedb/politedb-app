import { useCallback, useEffect, useMemo, useState } from "preact/hooks";

const DEFAULT_PAGE_SIZE = 40;

export function useInfiniteScroll<T>(
  items: T[],
  opts?: { pageSize?: number; resetKey?: string | number }
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

  const visibleItems = useMemo(
    () => items.slice(0, visibleCount),
    [items, visibleCount]
  );

  const hasMore = visibleCount < items.length;

  const loadMore = useCallback(() => {
    setVisibleCount((current) => Math.min(current + pageSize, items.length));
  }, [items.length, pageSize]);

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
    visibleCount,
    totalCount: items.length,
  };
}
