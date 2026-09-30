import type { CsvExportOptions } from "src/utils/csv";
import type { ColumnMeta } from "src/lib/tauri/types";
import type { TableFilterCondition, TableSort } from "src/lib/queries/sql";
import type { DatabaseEngine, TableConstraint } from "src/types";
import type { MaskingPolicy } from "src/lib/exportMasking";

export type ExportFormat = "csv" | "json" | "sql";

export type ExportProgress = {
  exported: number;
  error?: string;
  truncated?: boolean;
  warning?: string;
};

export type ExportOptions = {
  format: ExportFormat;
  fileName: string;
  columns: string[];
  csvOptions: CsvExportOptions;
  nullToEmpty: boolean;
  masked: boolean;
  maskingPolicy: MaskingPolicy | null;
};

export type ExportConfig = {
  columns: ColumnMeta[];
  connectionId: string | null;
  schema: string;
  tableName: string;
  engine?: DatabaseEngine;
  appliedFilters: TableFilterCondition[];
  appliedFilterCombine: "AND" | "OR";
  pagination?: { limit: number; offset: number };
  sortState?: TableSort | null;
  constraints?: TableConstraint[] | null;
};

export type FrozenExportRun = {
  path: string;
  config: ExportConfig;
  options: ExportOptions;
  /** SQL projection columns (Omit excluded in masked mode). */
  projectedColumns: string[];
  /** Columns written to the file after omit. */
  outputColumns: string[];
  policy: MaskingPolicy;
};
