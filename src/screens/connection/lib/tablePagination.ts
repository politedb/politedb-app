import { DEFAULT_LIMIT, DEFAULT_OFFSET } from "src/hooks/useLoadTableData";

export type TablePaginationState = {
  limit: number;
  offset: number;
};

const paginationByTableWindowId = new Map<string, TablePaginationState>();

export function getTablePagination(windowId: string): TablePaginationState {
  return (
    paginationByTableWindowId.get(windowId) ?? {
      limit: DEFAULT_LIMIT,
      offset: DEFAULT_OFFSET,
    }
  );
}

export function setTablePagination(
  windowId: string,
  state: TablePaginationState
): void {
  paginationByTableWindowId.set(windowId, state);
}

export function clearTablePagination(windowId: string): void {
  paginationByTableWindowId.delete(windowId);
}
