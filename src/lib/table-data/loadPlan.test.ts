import { describe, expect, it, vi } from "vitest";

const rowsWindow = vi.hoisted(() => ({ current: null as unknown }));

vi.mock("src/stores/connection", () => ({
  useConnectionStore: {
    getState: () => ({
      getRowsWindowInfo: () => rowsWindow.current,
    }),
  },
}));

import { computeLoadPlan, supportsMetaOnlyLoad } from "./loadPlan";

describe("computeLoadPlan meta", () => {
  it("requests structure/constraints on first load when constraints are missing", () => {
    const plan = computeLoadPlan({
      key: "tab.fleet.users_deleted",
      prev: {
        columns: null,
        structure: null,
        constraints: null,
        foreignKeys: null,
        sizeInfo: null,
        rowCount: null,
      },
      engine: "mysql",
      flags: {},
      pagination: { limit: 300, offset: 0 },
    });
    expect(plan.needMeta).toBe(true);
    expect(plan.needForeignKeys).toBe(true);
  });

  it("still requests foreign keys when constraints already loaded", () => {
    const plan = computeLoadPlan({
      key: "tab.fleet.host_software",
      prev: {
        columns: [{ name: "host_id", db_type: "int" }],
        structure: [],
        constraints: [
          {
            index_name: "PRIMARY",
            column_name: "host_id,software_id",
            is_primary: true,
            is_unique: true,
            index_algorithm: "BTREE",
          },
        ],
        foreignKeys: null,
        sizeInfo: { totalSize: "1", dataSize: "1", indexSize: "0" },
        rowCount: 10,
      },
      engine: "mysql",
      flags: { refreshRows: true },
      pagination: { limit: 300, offset: 0 },
    });
    expect(plan.needMeta).toBe(false);
    expect(plan.needForeignKeys).toBe(true);
  });

  it("skips meta reload once constraints array is present", () => {
    const plan = computeLoadPlan({
      key: "tab.fleet.users_deleted",
      prev: {
        columns: [{ name: "id", db_type: "int" }],
        structure: [],
        constraints: [
          {
            index_name: "PRIMARY",
            column_name: "id",
            is_primary: true,
            is_unique: true,
            index_algorithm: "BTREE",
          },
        ],
        foreignKeys: [],
        sizeInfo: { totalSize: "1", dataSize: "1", indexSize: "0" },
        rowCount: 10,
      },
      engine: "mysql",
      flags: { refreshRows: true },
      pagination: { limit: 300, offset: 0 },
    });
    expect(plan.needMeta).toBe(false);
    expect(plan.needForeignKeys).toBe(false);
  });
});

describe("computeLoadPlan metaOnly", () => {
  const prev = {
    columns: [{ name: "id", db_type: "int" }],
    structure: null,
    constraints: null,
    foreignKeys: null,
    sizeInfo: null,
    rowCount: null,
    error: 'column "nme" does not exist',
  };

  it.each([
    ["no rows window (the query failed before streaming)", null],
    [
      "an empty page after a failed stream",
      { streamOffset: 0, loadedMax: -1, running: false, cap: 1200 },
    ],
    [
      "rows for another page",
      { streamOffset: 300, loadedMax: 599, running: false, cap: 1200 },
    ],
  ])("loads structure only with %s", (_label, window) => {
    rowsWindow.current = window;
    const plan = computeLoadPlan({
      key: "tab.public.users",
      prev,
      engine: "postgres",
      flags: { metaOnly: true, refreshForeignKeys: true },
      pagination: { limit: 300, offset: 0 },
    });
    expect(plan).toMatchObject({
      needRows: false,
      needColumns: false,
      needRowCount: false,
      needSizeInfo: false,
      needMeta: true,
      needForeignKeys: true,
      needAnyMetaWork: true,
    });
    rowsWindow.current = null;
  });

  it("is offered only where the SQL loader runs", () => {
    expect(supportsMetaOnlyLoad("postgres")).toBe(true);
    expect(supportsMetaOnlyLoad("mysql")).toBe(true);
    for (const engine of ["mongo", "redis", "cassandra", "google_sheets"]) {
      expect(supportsMetaOnlyLoad(engine as never)).toBe(false);
    }
  });
});
