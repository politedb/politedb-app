import { useMemo, useState, useCallback } from "preact/hooks";

export type SortDirection = "asc" | "desc";

export interface SortState<TKey extends string | number | symbol> {
  key: TKey | null;
  direction: SortDirection;
}

export interface IndexedSortResult<TRow> {
  sortedRows: TRow[];
  indexMap: number[];
}

export interface UseIndexedSortResult<TRow, TKey extends keyof TRow> {
  sortState: SortState<TKey>;
  sortedRows: TRow[];
  indexMap: number[];
  toggleSort: (key: TKey) => void;
  setSort: (key: TKey | null, direction?: SortDirection) => void;
  findDisplayIndex: (originalIndex: number | null | undefined) => number | null;
}

function normalizeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).toLowerCase();
}

export function useIndexedSort<TRow, TKey extends keyof TRow>(
  rows: TRow[],
  options?: { initialKey?: TKey; initialDirection?: SortDirection }
): UseIndexedSortResult<TRow, TKey> {
  const [sortState, setSortState] = useState<SortState<TKey>>({
    key: options?.initialKey ?? null,
    direction: options?.initialDirection ?? "asc",
  });

  const { sortedRows, indexMap } = useMemo<IndexedSortResult<TRow>>(() => {
    const indexed = rows.map((row, index) => ({ row, index }));

    if (sortState.key != null) {
      const { key, direction } = sortState;
      indexed.sort((a, b) => {
        const leftRaw = a.row[key];
        const rightRaw = b.row[key];

        if (
          typeof leftRaw === "number" &&
          typeof rightRaw === "number" &&
          Number.isFinite(leftRaw) &&
          Number.isFinite(rightRaw)
        ) {
          if (leftRaw < rightRaw) return direction === "asc" ? -1 : 1;
          if (leftRaw > rightRaw) return direction === "asc" ? 1 : -1;
          return 0;
        }

        const left = normalizeValue(leftRaw);
        const right = normalizeValue(rightRaw);

        if (left < right) return direction === "asc" ? -1 : 1;
        if (left > right) return direction === "asc" ? 1 : -1;
        return 0;
      });
    }

    return {
      sortedRows: indexed.map((entry) => entry.row),
      indexMap: indexed.map((entry) => entry.index),
    };
  }, [rows, sortState]);

  const toggleSort = useCallback(
    (key: TKey) => {
      setSortState((previous) => {
        if (previous.key === key) {
          const nextDirection: SortDirection =
            previous.direction === "asc" ? "desc" : "asc";
          return { key, direction: nextDirection };
        }
        return { key, direction: "asc" };
      });
    },
    []
  );

  const setSort = useCallback((key: TKey | null, direction: SortDirection = "asc") => {
    setSortState({
      key,
      direction,
    });
  }, []);

  const findDisplayIndex = useCallback(
    (originalIndex: number | null | undefined): number | null => {
      if (originalIndex == null || originalIndex < 0) return null;
      const displayIndex = indexMap.indexOf(originalIndex);
      return displayIndex === -1 ? null : displayIndex;
    },
    [indexMap]
  );

  return {
    sortState,
    sortedRows,
    indexMap,
    toggleSort,
    setSort,
    findDisplayIndex,
  };
}
