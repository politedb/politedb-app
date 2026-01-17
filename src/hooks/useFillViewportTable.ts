import { RefObject } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";

interface UseFillViewportTableOptions {
  tableRef?: RefObject<HTMLTableElement>;
  dataLength: number;
  estimatedRowHeight?: number;
  fillViewport?: boolean;
  headerHeight?: number;
}

export function useFillViewportTable({
  tableRef,
  dataLength,
  estimatedRowHeight = 28,
  fillViewport = true,
  headerHeight,
}: UseFillViewportTableOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [emptyRowsCount, setEmptyRowsCount] = useState(0);

  useEffect(() => {
    if (!fillViewport || !containerRef.current) {
      setEmptyRowsCount(0);
      return;
    }

    const updateEmptyRows = () => {
      const container = containerRef.current;
      const table = tableRef?.current;
      if (!container) return;

      const containerHeight = container.clientHeight;

      // Get header height from table element or use provided/default
      let actualHeaderHeight = headerHeight;
      if (!actualHeaderHeight && table) {
        actualHeaderHeight = table.querySelector("thead")?.clientHeight || 0;
      }
      if (!actualHeaderHeight) {
        actualHeaderHeight = 40; // Default header height
      }

      const availableHeight = containerHeight - actualHeaderHeight;

      // Calculate how many rows fit
      const actualRowsHeight = dataLength * estimatedRowHeight;

      if (actualRowsHeight < availableHeight) {
        const remainingHeight = availableHeight - actualRowsHeight;
        const additionalRows = Math.ceil(remainingHeight / estimatedRowHeight);
        setEmptyRowsCount((prev) =>
          prev !== additionalRows ? additionalRows : prev
        );
      } else {
        setEmptyRowsCount((prev) => (prev !== 0 ? 0 : prev));
      }
    };

    updateEmptyRows();

    const resizeObserver = new ResizeObserver(updateEmptyRows);
    resizeObserver.observe(containerRef.current);

    return () => resizeObserver.disconnect();
  }, [
    dataLength,
    fillViewport,
    estimatedRowHeight,
    headerHeight,
    // Note: containerRef and tableRef are refs and don't need to be in deps
    // but we include tableRef?.current in the closure for safety
  ]);

  return { emptyRowsCount, containerRef };
}
