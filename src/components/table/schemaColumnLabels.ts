import type { TableConstraint, TableStructure } from "src/types";

/** Header text for the structure editor's columns. */
export const STRUCTURE_COLUMN_LABELS: Partial<
  Record<keyof TableStructure, string>
> = {
  column_name: "Name",
  data_type: "Type",
  is_nullable: "Nullable",
  column_default: "Default",
  foreign_key: "Foreign key",
  comment: "Comment",
  check: "Check",
};

/** Header text for the index editor's columns. */
export const INDEX_COLUMN_LABELS: Partial<
  Record<keyof TableConstraint, string>
> = {
  index_name: "Name",
  index_algorithm: "Algorithm",
  is_unique: "Unique",
  column_name: "Columns",
  condition: "Condition",
  include: "Include",
  comment: "Comment",
};

/** Nullable choices, written the way the catalog reports them. */
export const NULLABLE_OPTIONS = [
  { label: "YES", value: "YES" },
  { label: "NO", value: "NO" },
];

/** Starting widths: short flags narrow, free text wide. */
export const STRUCTURE_COLUMN_WIDTHS: Partial<
  Record<keyof TableStructure, number>
> = {
  column_name: 200,
  data_type: 170,
  is_nullable: 100,
  column_default: 220,
  foreign_key: 220,
  comment: 320,
  check: 220,
};

export const INDEX_COLUMN_WIDTHS: Partial<
  Record<keyof TableConstraint, number>
> = {
  index_name: 240,
  index_algorithm: 120,
  is_unique: 90,
  column_name: 280,
  condition: 260,
  include: 200,
  comment: 260,
};
