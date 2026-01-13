import { useCallback, useMemo } from "preact/hooks";
import { ColumnMeta } from "../lib/tauri";

type RawRow = any[] | Record<number, any>;

export type NormalizedRow = Record<string, any> & {
  __rowIndex: number;
};

export function useNormalizeTableData(
  columns: ColumnMeta[],
  data: RawRow[] | undefined
) {
  // Normalize data: convert objects with numeric keys to arrays
  const normalizeData = useCallback((data: RawRow[]): any[][] => {
    if (!data || data.length === 0) return [];

    return data.map((row) => {
      if (Array.isArray(row)) {
        return row;
      }

      if (typeof row === "object" && row !== null) {
        const keys = Object.keys(row)
          .map(Number)
          .filter((k) => !isNaN(k))
          .sort((a, b) => a - b);

        return keys.map((key) => (row as Record<number, any>)[key]);
      }

      return [];
    });
  }, []);

  const normalizedData = useMemo(
    () => (data ? normalizeData(data) : []),
    [data, normalizeData]
  );

  const tableData: NormalizedRow[] = useMemo(() => {
    if (!normalizedData.length) return [];

    return normalizedData.map((row, index) => {
      const rowArray = Array.isArray(row) ? row : [];

      const record = rowArray.reduce<Record<string, any>>(
        (acc, cell, colIndex) => {
          const col = columns[colIndex];
          if (col) acc[col.name] = cell;
          return acc;
        },
        {}
      );

      return {
        ...record,
        __rowIndex: index,
      };
    });
  }, [normalizedData, columns]);

  return { tableData };
}
