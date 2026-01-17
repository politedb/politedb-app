import { useCallback } from "preact/hooks";

export interface UseTablePatchesProps {
  patches?: Record<string, Record<string, any>> | null;
  newRowKeys?: string[];
  deletedRows?: Set<number>;
  editedDataLength: number;
}

export function useTablePatches({
  patches,
  deletedRows = new Set(),
  editedDataLength,
}: UseTablePatchesProps) {
  // Get row key for a given row index (handles both numeric indices and new row string keys)
  const getRowKey = useCallback(
    (rowIndex: number, newRows: any[]): string => {
      // Check if this is a new row (index >= editedDataLength)
      if (rowIndex >= editedDataLength) {
        const newRowIndex = rowIndex - editedDataLength;
        const newRow = newRows[newRowIndex];
        return newRow?.rowKey || String(rowIndex);
      }
      return String(rowIndex);
    },
    [editedDataLength]
  );

  // Check if a row is a new row (for create action)
  const isNewRow = useCallback(
    (rowIndex: number): boolean => {
      return rowIndex >= editedDataLength;
    },
    [editedDataLength]
  );

  // Check if a row is deleted
  const isRowDeleted = useCallback(
    (rowIndex: number): boolean => {
      // For new rows, check if they're in deletedRows
      if (rowIndex >= editedDataLength) {
        return false; // New rows can't be deleted this way
      }
      return deletedRows.has(rowIndex);
    },
    [deletedRows, editedDataLength]
  );

  // For update cell rendering, prefer patched value over original
  const getPatchedValue = useCallback(
    (rowIndex: number, colName: string, fallback: any, newRows: any[]) => {
      const rowKey = getRowKey(rowIndex, newRows);
      const rowPatch = patches?.[rowKey];
      if (!rowPatch) return fallback;
      if (Object.prototype.hasOwnProperty.call(rowPatch, colName))
        return rowPatch[colName];
      return fallback;
    },
    [patches, getRowKey]
  );

  const isCellPatched = useCallback(
    (rowIndex: number, colName: string, newRows: any[]) => {
      const rowKey = getRowKey(rowIndex, newRows);
      const rowPatch = patches?.[rowKey];
      return (
        !!rowPatch && Object.prototype.hasOwnProperty.call(rowPatch, colName)
      );
    },
    [patches, getRowKey]
  );

  const isRowPatched = useCallback(
    (rowIndex: number, newRows: any[]) => {
      const rowKey = getRowKey(rowIndex, newRows);
      const rowPatch = patches?.[rowKey];
      return !!rowPatch && Object.keys(rowPatch).length > 0;
    },
    [patches, getRowKey]
  );

  return {
    getRowKey,
    isNewRow,
    isRowDeleted,
    getPatchedValue,
    isCellPatched,
    isRowPatched,
  };
}
