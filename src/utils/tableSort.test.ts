import { describe, expect, it } from "vitest";
import { resolveDefaultTableSort } from "./tableSort";

describe("resolveDefaultTableSort", () => {
  it("uses primary key from constraints", () => {
    expect(
      resolveDefaultTableSort({
        engine: "postgres",
        columns: [{ name: "id" }, { name: "name" }],
        constraints: [
          {
            index_name: "scanner_logs_pkey",
            index_algorithm: "btree",
            column_name: "id",
            is_primary: true,
            is_unique: true,
          },
        ],
      })
    ).toEqual({ colName: "id", direction: "asc" });
  });

  it("uses is_primary on columns when constraints are missing", () => {
    expect(
      resolveDefaultTableSort({
        engine: "postgres",
        columns: [{ name: "name" }, { name: "id", is_primary: true }],
      })
    ).toEqual({ colName: "id", direction: "asc" });
  });

  it("falls back to id column name", () => {
    expect(
      resolveDefaultTableSort({
        engine: "postgres",
        columns: [{ name: "name" }, { name: "id" }],
      })
    ).toEqual({ colName: "id", direction: "asc" });
  });

  it("skips sort for mongo", () => {
    expect(
      resolveDefaultTableSort({
        engine: "mongo",
        columns: [{ name: "id" }],
      })
    ).toBeNull();
  });
});
