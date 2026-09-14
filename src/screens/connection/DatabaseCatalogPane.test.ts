import { describe, expect, it } from "vitest";
import type { DatabaseObjectItem, TableItem } from "src/types";
import {
  FUNCTION_COLUMNS,
  TABLE_COLUMNS,
  catalogRowValues,
  sortCatalogRows,
} from "./DatabaseCatalogPane";

const tables: TableItem[] = [
  {
    schema: "public",
    name: "orders",
    kind: "table",
    owner: "app",
    estimatedRow: 20,
    totalSize: "2048",
    comment: "sales",
  },
  {
    schema: "public",
    name: "users",
    kind: "view",
    owner: "admin",
    estimatedRow: 3,
    totalSize: "1024",
  },
];

const fn = (name: string): DatabaseObjectItem => ({
  id: `public.${name}`,
  kind: "function",
  schema: "public",
  name,
  signature: `${name}()`,
  engine: "postgres",
  capability: {
    canList: true,
    canReadDefinition: true,
    canCreate: false,
    canEdit: false,
    canDelete: false,
  },
});

describe("catalog canvas rows", () => {
  it("projects table metadata into canvas cell values", () => {
    expect(catalogRowValues(tables[0], TABLE_COLUMNS)).toEqual([
      "orders",
      "public",
      "TABLE",
      "app",
      "20",
      "2 KB",
      "--",
      "--",
      "sales",
    ]);
  });

  it("sorts estimated_row numerically", () => {
    const sorted = sortCatalogRows(tables, TABLE_COLUMNS, {
      colName: "estimated_row",
      direction: "asc",
    });
    expect(sorted.map((row) => row.name)).toEqual(["users", "orders"]);
  });

  it("projects function capability flags", () => {
    expect(catalogRowValues(fn("now"), FUNCTION_COLUMNS)).toEqual([
      "now",
      "public",
      "FUNCTION",
      "now()",
      "YES",
      "NO",
      "NO",
      "",
    ]);
  });
});
