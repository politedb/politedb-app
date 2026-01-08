import { useCallback, useMemo } from "preact/hooks";
import { ColumnMeta } from "../lib/tauri";

export function useNormalizeTableData(columns: ColumnMeta[], data: any[]) {
  // Normalize data: convert objects with numeric keys to arrays
  const normalizeData = useCallback((data: any[]) => {
    if (!data || data.length === 0) return [];

    return data.map((row) => {
      // If row is already an array, return it
      if (Array.isArray(row)) {
        return row;
      }

      // If row is an object with numeric keys, convert to array
      if (typeof row === "object" && row !== null) {
        // Get all numeric keys and sort them
        const keys = Object.keys(row)
          .map(Number)
          .filter((k) => !isNaN(k))
          .sort((a, b) => a - b);

        // Return array of values in order
        return keys.map((key) => row[key]);
      }

      // Fallback: return empty array
      return [];
    });
  }, []);

  const normalizedData = useMemo(
    () => normalizeData(data),
    [data, normalizeData]
  );

  // Transform data for react-table
  const tableData = useMemo(() => {
    if (!normalizedData || normalizedData.length === 0) return [];

    return normalizedData.map((row, index) => {
      // Ensure row is an array
      const rowArray = Array.isArray(row) ? row : [];

      return {
        ...rowArray.reduce(
          (acc, cell, colIndex) => {
            acc[columns[colIndex].name] = cell;
            return acc;
          },
          {} as Record<string, any>
        ),
        __rowIndex: index,
      };
    });
  }, [normalizedData]);

  return { tableData };
}
