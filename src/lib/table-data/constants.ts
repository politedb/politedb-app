export function tableKey(
  activeScreen: string,
  schema: string,
  tableName: string
) {
  return `${activeScreen}.${schema}.${tableName}`;
}

export type TablePagination = { limit: number; offset: number };

export const DEFAULT_LIMIT = 300;
export const DEFAULT_OFFSET = 0;

export const RETRY_ATTEMPTS = 8;

export const EMPTY_META = {
  columns: null,
  structure: null,
  constraints: null,
  foreignKeys: null,
  sizeInfo: null,
  rowCount: null,
  rowCountIsEstimated: false,
  connectionId: null,
  busy: false,
  error: null,
};
