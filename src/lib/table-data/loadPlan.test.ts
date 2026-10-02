import { describe, expect, it, vi } from "vitest";

vi.mock("src/stores/connection", () => ({
  useConnectionStore: {
    getState: () => ({
      getRowsWindowInfo: () => null,
    }),
  },
}));

import { computeLoadPlan } from "./loadPlan";

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
