import { useMemo } from "preact/hooks";

export interface UseTablePatchesProps {
  patches?: Record<string, Record<string, any>> | null;
  newRowKeys?: string[];
  deletedRows?: Set<number>;
  editedDataLength: number;
}

export function createTablePatchHelpers({
  patches,
  deletedRows = new Set<number>(),
  editedDataLength,
}: UseTablePatchesProps) {
  const getRowKey = (
    rowIndex: number,
    newRows: { rowKey: string }[]
  ): string => {
    if (rowIndex >= editedDataLength) {
      const newRowIndex = rowIndex - editedDataLength;
      const newRow = newRows[newRowIndex];
      return newRow?.rowKey || String(rowIndex);
    }
    return String(rowIndex);
  };

  const isNewRow = (rowIndex: number): boolean => rowIndex >= editedDataLength;

  const isRowDeleted = (rowIndex: number): boolean => {
    if (rowIndex >= editedDataLength) return false;
    return deletedRows.has(rowIndex);
  };

  const getPatchedValue = (
    rowIndex: number,
    colName: string,
    fallback: unknown,
    newRows: { rowKey: string }[]
  ) => {
    const rowKey = getRowKey(rowIndex, newRows);
    const rowPatch = patches?.[rowKey];
    if (!rowPatch) return fallback;
    if (Object.prototype.hasOwnProperty.call(rowPatch, colName))
      return rowPatch[colName];
    return fallback;
  };

  const isCellPatched = (
    rowIndex: number,
    colName: string,
    newRows: { rowKey: string }[]
  ) => {
    const rowKey = getRowKey(rowIndex, newRows);
    const rowPatch = patches?.[rowKey];
    return (
      !!rowPatch && Object.prototype.hasOwnProperty.call(rowPatch, colName)
    );
  };

  const isRowPatched = (rowIndex: number, newRows: { rowKey: string }[]) => {
    const rowKey = getRowKey(rowIndex, newRows);
    const rowPatch = patches?.[rowKey];
    return !!rowPatch && Object.keys(rowPatch).length > 0;
  };

  return {
    getRowKey,
    isNewRow,
    isRowDeleted,
    getPatchedValue,
    isCellPatched,
    isRowPatched,
  };
}

export function useTablePatches(props: UseTablePatchesProps) {
  const { patches, deletedRows = new Set(), editedDataLength } = props;
  return useMemo(
    () => createTablePatchHelpers({ patches, deletedRows, editedDataLength }),
    [patches, deletedRows, editedDataLength]
  );
}
