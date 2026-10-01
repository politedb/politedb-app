import { describe, expect, it } from "vitest";
import { buildPatchDiffs } from "./patchDiff";
import type { PatchMap } from "./generateSql";

describe("buildPatchDiffs", () => {
  it("builds insert update and delete row diffs", () => {
    const patchMap: PatchMap = {
      win1: {
        tableWindow: {
          id: "win1",
          type: "table",
          table: { schema: "public", name: "users" },
        },
        tableData: {
          columns: [
            { name: "id", db_type: "int" },
            { name: "name", db_type: "text" },
          ],
          rows: [],
          rowCount: 2,
        } as any,
        patches: {
          create: { data: { new_1: { id: 2, name: "Ada" } } },
          update: { data: { "0": { name: "Grace" } } },
          delete: { data: { "1": {} } },
        },
      },
    };

    const diffs = buildPatchDiffs(patchMap, {
      activeScreen: "tab1",
      getRowAt: (_key, index) =>
        index === 0 ? [1, "Old"] : index === 1 ? [3, "Delete me"] : undefined,
    });

    expect(diffs.map((diff) => diff.action)).toEqual([
      "insert",
      "update",
      "delete",
    ]);
    expect(diffs[1]?.cells).toEqual([
      { column: "name", oldValue: "Old", newValue: "Grace" },
    ]);
    expect(diffs[2]?.identity).toBe("Virtual key: id=3, name=Delete me");
  });

  it("uses original cached rows before live patched rows", () => {
    const patchMap: PatchMap = {
      win1: {
        tableWindow: {
          id: "win1",
          type: "table",
          table: { schema: "public", name: "licenses" },
        },
        tableData: {
          columns: [
            { name: "id", db_type: "uuid" },
            { name: "customer_email", db_type: "text" },
          ],
          constraints: [
            {
              index_name: "licenses_pkey",
              index_algorithm: "BTREE",
              is_unique: true,
              is_primary: true,
              column_name: "id",
            },
          ],
          rows: [],
          rowCount: 1,
        } as any,
        patches: {
          update: { data: { "0": { customer_email: null } } },
        },
      },
    };

    const diffs = buildPatchDiffs(patchMap, {
      activeScreen: "tab1",
      getRowAt: () => ["d481", null],
      getOriginalRowAt: () => ["d481", "tony@example.com"],
    });

    expect(diffs[0]?.cells).toEqual([
      {
        column: "customer_email",
        oldValue: "tony@example.com",
        newValue: "",
      },
    ]);
  });
});
