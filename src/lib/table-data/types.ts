import type { TableFilterCondition, TableSort } from "src/lib/queries/sql";

export type LoadFlags = {
  force?: boolean;
  forceRefresh?: boolean;
  forceRows?: boolean;
  refreshRowCount?: boolean;
  exactRowCount?: boolean;
  refreshRows?: boolean;
  refreshMeta?: boolean;
  refreshForeignKeys?: boolean;
  refreshStats?: boolean;
  filters?: TableFilterCondition[];
  filterCombine?: "AND" | "OR";
  sortBy?: TableSort | null;
};

export type ColumnRow = {
  name: string | null;
  db_type: string | null;
  is_primary?: boolean;
  column_default?: string | null;
};

export type LoadPlan = {
  key: string;
  prev: any;

  force: boolean;
  isFirstLoad: boolean;

  needColumns: boolean;
  needRows: boolean;
  needRowCount: boolean;
  needSizeInfo: boolean;
  needMeta: boolean;
  needForeignKeys: boolean;

  needAnyMetaWork: boolean;
};
