import { describe, expect, it } from "vitest";
import {
  buildMongoOperations,
  generateSqlFromPatches,
  type PatchMap,
} from "./generateSql";
import { buildPatchDiffs } from "./patchDiff";

function usersPatchMap(
  patches: PatchMap[string]["patches"],
  originalRows?: Record<string, unknown[]>
): PatchMap {
  return {
    "table:public.users": {
      tableWindow: {
        id: "table:public.users",
        type: "table",
        table: { schema: "public", name: "users" },
      },
      tableData: {
        columns: [
          { name: "id", db_type: "int" },
          { name: "name", db_type: "text" },
        ],
        structure: null,
        constraints: [
          {
            index_name: "users_pkey",
            index_algorithm: "BTREE",
            is_unique: true,
            is_primary: true,
            column_name: "id",
          },
        ],
        foreignKeys: null,
        sizeInfo: null,
        rowCount: 100,
        connectionId: "conn",
        busy: false,
        error: null,
      },
      patches,
      originalRows,
    },
  } as PatchMap;
}

// Rows now loaded at every position belong to someone else (another page,
// sort, filter or reload happened after the edits).
const otherRows = (_key: string, index: number) => [1000 + index, "Other"];

describe("row patches that recorded their row", () => {
  it("update and delete the recorded rows, whatever is loaded now", () => {
    const sql = generateSqlFromPatches(
      usersPatchMap(
        {
          update: { data: { "0": { name: "Ada" } } },
          delete: { data: { "2": {} } },
        },
        { "0": [1, "A"], "2": [3, "C"] }
      ),
      "postgres",
      {
        activeScreen: "screen",
        offset: 100,
        getRowAt: otherRows,
        getOriginalRowAt: otherRows,
      }
    );

    expect(sql).toHaveLength(2);
    expect(sql[0]).toBe(
      `UPDATE "public"."users"\nSET "name" = 'Ada'\nWHERE "id" = 1;`
    );
    expect(sql[1]).toContain(`"id" = 3`);
    expect(sql.join("\n")).not.toMatch(/10\d\d/);
  });

  it("still resolve older patches by position", () => {
    const sql = generateSqlFromPatches(
      usersPatchMap({ update: { data: { "0": { name: "Ada" } } } }),
      "postgres",
      { activeScreen: "screen", offset: 50, getRowAt: otherRows }
    );
    expect(sql[0]).toContain(`WHERE "id" = 1050;`);
  });

  it("previews Mongo operations against the recorded documents", () => {
    const patchMap = usersPatchMap(
      {
        update: { data: { "0": { name: "Ada" } } },
        delete: { data: { "1": {} } },
      },
      { "0": ["a1", "A"], "1": ["b2", "B"] }
    );
    const columns = patchMap["table:public.users"]!.tableData!.columns!;
    columns[0] = { name: "_id", db_type: "objectId" } as any;
    const ops = buildMongoOperations(patchMap, {
      activeScreen: "screen",
      offset: 0,
      getRowAt: otherRows,
    });
    expect(ops).toEqual([
      `db.users.updateOne({ _id: "a1" }, { $set: { name: "Ada" } })`,
      `db.users.deleteMany({ _id: { $in: ["b2"] } })`,
    ]);
  });

  it("describe the recorded rows in the change list", () => {
    const diffs = buildPatchDiffs(
      usersPatchMap(
        { update: { data: { "0": { name: "Ada" } } } },
        { "0": [1, "A"] }
      ),
      { activeScreen: "screen", offset: 100, getRowAt: otherRows }
    );
    expect(diffs).toHaveLength(1);
    expect(diffs[0]!.cells).toEqual([
      { column: "name", oldValue: "A", newValue: "Ada" },
    ]);
    expect(diffs[0]!.identity).toContain("1");
    expect(diffs[0]!.identity).not.toContain("1000");
  });

  it("never writes the record into a column with the same name", () => {
    const patchMap = usersPatchMap(
      { update: { data: { "0": { name: "Ada" } } } },
      { "0": [1, "A", "keep"] }
    );
    patchMap["table:public.users"]!.tableData!.columns!.push({
      name: "__originalRow",
      db_type: "text",
    } as any);
    const sql = generateSqlFromPatches(patchMap, "postgres", {
      activeScreen: "screen",
      getRowAt: otherRows,
    });
    expect(sql).toEqual([
      `UPDATE "public"."users"\nSET "name" = 'Ada'\nWHERE "id" = 1;`,
    ]);
  });
});
