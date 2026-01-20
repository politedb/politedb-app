import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "preact/hooks";
import type { ColumnMeta } from "src/lib/tauri/types";
import {
  type NewRowData,
  EMPTY_ARRAY,
  MIN_COL_WIDTH,
  MAX_COL_WIDTH,
  DEFAULT_COL_WIDTH,
  MAX_RESIZE_WIDTH,
  clamp,
  guessWidthByMeta,
  inferCellType,
} from "./tableUtils";

// ============================================================================
// useColumnSizing
// ============================================================================

export function useColumnSizing(columns: ColumnMeta[]) {
  // Stable key for column identity
  const columnsKey = useMemo(
    () => columns.map((c) => c.name).join("\0"),
    [columns]
  );

  const [columnSizes, setColumnSizes] = useState<Record<string, number>>(() => {
    const initial: Record<string, number> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      initial[col.name] = clamp(
        guessWidthByMeta(col),
        MIN_COL_WIDTH,
        MAX_COL_WIDTH
      );
    }
    return initial;
  });

  // Sync column sizes with columns (add new, remove stale)
  useEffect(() => {
    setColumnSizes((prev) => {
      let next: Record<string, number> | null = null;

      // Add missing
      for (let i = 0; i < columns.length; i++) {
        const col = columns[i];
        if (prev[col.name] == null) {
          if (!next) next = { ...prev };
          next[col.name] = clamp(
            guessWidthByMeta(col),
            MIN_COL_WIDTH,
            MAX_COL_WIDTH
          );
        }
      }

      // Remove stale (only if we have extra keys)
      const prevKeys = Object.keys(prev);
      if (prevKeys.length > columns.length) {
        const nameSet = new Set(columns.map((c) => c.name));
        for (let i = 0; i < prevKeys.length; i++) {
          if (!nameSet.has(prevKeys[i])) {
            if (!next) next = { ...prev };
            delete next[prevKeys[i]];
          }
        }
      }

      return next ?? prev;
    });
  }, [columnsKey]);

  // Memoized width lookup
  const widthByName = useMemo(() => {
    const out: Record<string, number> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      out[col.name] = columnSizes[col.name] ?? DEFAULT_COL_WIDTH;
    }
    return out;
  }, [columnsKey, columnSizes]);

  // Total width (simple loop, no reduce overhead)
  const totalWidth = useMemo(() => {
    let sum = 0;
    for (let i = 0; i < columns.length; i++) {
      sum += widthByName[columns[i].name];
    }
    return sum;
  }, [columnsKey, widthByName]);

  const resetColumnWidth = useCallback((col: ColumnMeta) => {
    const w = clamp(guessWidthByMeta(col), MIN_COL_WIDTH, MAX_COL_WIDTH);
    setColumnSizes((prev) =>
      prev[col.name] === w ? prev : { ...prev, [col.name]: w }
    );
  }, []);

  return {
    columnsKey,
    columnSizes,
    setColumnSizes,
    widthByName,
    totalWidth,
    resetColumnWidth,
  };
}

// ============================================================================
// useColumnResize
// ============================================================================

export function useColumnResize(
  widthByName: Record<string, number>,
  setColumnSizes: (
    fn: (prev: Record<string, number>) => Record<string, number>
  ) => void
) {
  const stateRef = useRef({
    colName: null as string | null,
    startX: 0,
    startWidth: 0,
    pendingWidth: null as number | null,
    rafId: null as number | null,
  });

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (stateRef.current.rafId != null) {
        cancelAnimationFrame(stateRef.current.rafId);
      }
    };
  }, []);

  // Stable reference - no deps needed
  const handlers = useMemo(() => {
    const commitResize = () => {
      const { colName, pendingWidth } = stateRef.current;
      if (!colName || pendingWidth == null) return;

      setColumnSizes((prev) =>
        prev[colName] === pendingWidth
          ? prev
          : { ...prev, [colName]: pendingWidth }
      );
    };

    return {
      onPointerDown: (colName: string, e: PointerEvent) => {
        e.preventDefault();
        e.stopPropagation();

        const state = stateRef.current;
        state.colName = colName;
        state.startX = e.clientX;
        state.startWidth = widthByName[colName] ?? DEFAULT_COL_WIDTH;

        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {}
      },

      onPointerMove: (e: PointerEvent) => {
        const state = stateRef.current;
        if (!state.colName) return;

        const diff = e.clientX - state.startX;
        state.pendingWidth = clamp(
          state.startWidth + diff,
          MIN_COL_WIDTH,
          MAX_RESIZE_WIDTH
        );

        if (state.rafId != null) return;
        state.rafId = requestAnimationFrame(() => {
          state.rafId = null;
          commitResize();
        });
      },

      onPointerUp: (e: PointerEvent) => {
        const state = stateRef.current;
        if (!state.colName) return;
        state.colName = null;

        try {
          (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
        } catch {}
      },
    };
  }, [widthByName, setColumnSizes]);

  return handlers;
}

// ============================================================================
// useContainerWidth
// ============================================================================

export function useContainerWidth() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Use RAF to batch resize observations
    let rafId: number | null = null;
    let pendingWidth: number | null = null;

    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width == null || width === pendingWidth) return;

      pendingWidth = width;
      if (rafId != null) return;

      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (pendingWidth != null) setContainerWidth(pendingWidth);
      });
    });

    ro.observe(el);
    return () => {
      ro.disconnect();
      if (rafId != null) cancelAnimationFrame(rafId);
    };
  }, []);

  return { containerRef, containerWidth };
}

// ============================================================================
// useNewRows
// ============================================================================

export function useNewRows(
  patches: Record<string, Record<string, any>> | null | undefined,
  newRowKeys: string[],
  columns: ColumnMeta[],
  columnsKey: string
): NewRowData[] {
  return useMemo(() => {
    if (!patches || newRowKeys.length === 0)
      return EMPTY_ARRAY as unknown as NewRowData[];

    const result: NewRowData[] = [];
    for (let i = 0; i < newRowKeys.length; i++) {
      const rowKey = newRowKeys[i];
      const patchData = patches[rowKey];
      if (!patchData) continue;

      const row: Record<string, { v: any; t: string }> = {};
      for (let j = 0; j < columns.length; j++) {
        const col = columns[j];
        const value = patchData[col.name] ?? null;
        row[col.name] = { v: value, t: inferCellType(value) };
      }
      result.push({ row, rowKey, isNew: true });
    }
    return result;
  }, [patches, newRowKeys, columnsKey]);
}

// ============================================================================
// useMergedRefs
// ============================================================================

export function useMergedRefs<T>(
  ...refs: Array<
    | React.MutableRefObject<T | null>
    | ((node: T | null) => void)
    | null
    | undefined
  >
) {
  return useCallback((node: T | null) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") {
        ref(node);
      } else {
        (ref as React.MutableRefObject<T | null>).current = node;
      }
    }
  }, refs);
}
