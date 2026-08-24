import {
  useMemo,
  useState,
  useEffect,
  useCallback,
  useRef,
  MutableRef,
} from "preact/hooks";
import type { ColumnMeta } from "src/lib/tauri/types";
import {
  type NewRowData,
  MIN_COL_WIDTH,
  MAX_COL_WIDTH,
  DEFAULT_COL_WIDTH,
  MAX_RESIZE_WIDTH,
  clamp,
  guessWidthByMeta,
  inferCellType,
} from "./tableUtils";
import { TableFilterCondition } from "src/lib/queries/sql";
import { useConnectionStore } from "src/stores/connection";
import { DEFAULT_FILTER_STATE } from "src/constant";

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
  }, [columns, columnsKey]);

  // Memoized width lookup
  const widthByName = useMemo(() => {
    const out: Record<string, number> = {};
    for (let i = 0; i < columns.length; i++) {
      const col = columns[i];
      out[col.name] = columnSizes[col.name] ?? DEFAULT_COL_WIDTH;
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columnsKey, columnSizes]);

  // Total width (simple loop, no reduce overhead)
  const totalWidth = useMemo(() => {
    let sum = 0;
    for (let i = 0; i < columns.length; i++) {
      sum += widthByName[columns[i].name];
    }
    return sum;
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        // eslint-disable-next-line react-hooks/exhaustive-deps
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

export function buildNewRowsFromPatches(
  patches: Record<string, Record<string, unknown>> | null | undefined,
  newRowKeys: string[],
  columns: ColumnMeta[]
): NewRowData[] {
  if (!patches || newRowKeys.length === 0) return [];

  const result: NewRowData[] = [];
  for (let i = 0; i < newRowKeys.length; i++) {
    const rowKey = newRowKeys[i];
    const patchData = patches[rowKey];
    if (!patchData) continue;

    const row: Record<string, { v: unknown; t: string }> = {};
    for (let j = 0; j < columns.length; j++) {
      const col = columns[j];
      const value = patchData[col.name] ?? null;
      row[col.name] = { v: value, t: inferCellType(value) };
    }
    result.push({ row, rowKey, isNew: true });
  }
  return result;
}

export function useNewRows(
  patches: Record<string, Record<string, any>> | null | undefined,
  newRowKeys: string[],
  columns: ColumnMeta[],
  columnsKey: string
): NewRowData[] {
  return useMemo(
    () => buildNewRowsFromPatches(patches, newRowKeys, columns),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [patches, newRowKeys, columnsKey]
  );
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
  return useCallback(
    (node: T | null) => {
      for (const ref of refs) {
        if (!ref) continue;
        if (typeof ref === "function") {
          ref(node);
        } else {
          (ref as React.MutableRefObject<T | null>).current = node;
        }
      }
    },
    [refs]
  );
}

// ============================================================================
// useTableFilter
// ============================================================================

export function useTableFilter(
  startedRef: MutableRef<string | null>,
  key: string
) {
  const setTableFilter = useConnectionStore((s) => s.setTableFilter);
  const clearTableFilter = useConnectionStore((s) => s.clearTableFilter);
  const tableFilters = useConnectionStore((s) => s.tableFilterByKey);

  const current = useMemo(
    () => tableFilters[key] ?? DEFAULT_FILTER_STATE,
    [tableFilters, key]
  );

  const handleApplyFilters = useCallback(
    (
      newFilters: TableFilterCondition[],
      combine: "AND" | "OR",
      tableKey: string
    ) => {
      setTableFilter(tableKey, {
        ...current,
        appliedFilters: newFilters,
        appliedFilterCombine: combine,
        filterApplySeq: (current.filterApplySeq ?? 0) + 1,
      });
      startedRef.current = null; // allow effect to run with new filters
    },
    [setTableFilter, current, startedRef]
  );

  const handleClearFilters = useCallback(
    (visible: boolean = true) => {
      clearTableFilter(key, visible);
      startedRef.current = null; // allow effect to run without filters
    },
    [clearTableFilter, key, startedRef]
  );

  const setFilters = useCallback(
    (next: TableFilterCondition[]) => {
      setTableFilter(key, { ...current, filters: next });
    },
    [setTableFilter, key, current]
  );

  const setFilterCombine = useCallback(
    (combine: "AND" | "OR") => {
      setTableFilter(key, { ...current, filterCombine: combine });
    },
    [setTableFilter, key, current]
  );

  const setFilterBarVisible = useCallback(
    (visible: boolean | ((prev: boolean) => boolean), tableKey: string) => {
      setTableFilter(tableKey, {
        ...current,
        filterBarVisible:
          typeof visible === "function"
            ? visible(current.filterBarVisible)
            : visible,
      });
    },
    [setTableFilter, current]
  );

  return {
    filterBarVisible: current.filterBarVisible,
    filters: current.filters ?? [],
    filterCombine: current.filterCombine ?? "AND",
    appliedFilters: current.appliedFilters ?? [],
    appliedFilterCombine: current.appliedFilterCombine ?? "AND",
    filterApplySeq: current.filterApplySeq ?? 0,

    setFilters,
    setFilterCombine,
    setFilterBarVisible,

    handleApplyFilters,
    handleClearFilters,
  };
}
