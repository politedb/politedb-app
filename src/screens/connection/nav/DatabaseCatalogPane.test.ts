import { describe, expect, it } from "vitest";
import type { DatabaseObjectItem, TableItem } from "src/types";
import {
  FUNCTION_COLUMNS,
  TABLE_COLUMNS,
  catalogRowMenuItems,
  catalogRowValues,
  openCatalogRowMenu,
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

describe("catalog row context menu target", () => {
  it("keeps Export targeted at the clicked row after live rows reorder", () => {
    const tableA: TableItem = {
      schema: "public",
      name: "a",
      kind: "table",
    };
    const tableB: TableItem = {
      schema: "public",
      name: "b",
      kind: "table",
    };
    const initial = [tableA, tableB];
    // Right-click B at index 1
    const menu = openCatalogRowMenu(initial, 1, 10, 20);
    expect(menu?.row.name).toBe("b");

    // Metadata refresh reorders so A and B swap positions
    const reordered = [tableB, tableA];
    const exported: string[] = [];
    const items = catalogRowMenuItems(menu, (table) => [
      {
        type: "item" as const,
        label: "Export data...",
        onClick: () => {
          exported.push(table.name);
        },
      },
    ]);

    // Live index 1 would now be A — frozen menu must still export B
    expect(reordered[1]?.name).toBe("a");
    const exportItem = items.find(
      (item) => item.type === "item" && item.label === "Export data..."
    );
    expect(exportItem && exportItem.type === "item").toBe(true);
    if (exportItem && exportItem.type === "item") {
      exportItem.onClick?.();
    }
    expect(exported).toEqual(["b"]);
  });

  it("returns null for an invalid row index", () => {
    expect(openCatalogRowMenu(tables, -1, 0, 0)).toBeNull();
    expect(openCatalogRowMenu(tables, 99, 0, 0)).toBeNull();
  });
});
