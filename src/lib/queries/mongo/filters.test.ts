import { describe, expect, it } from "vitest";
import {
  buildMongoFilter,
  buildMongoSort,
  formatMongoFindPreview,
} from "./filters";
import type { TableFilterCondition } from "src/lib/queries/sql/filters";

function filter(
  patch: Partial<TableFilterCondition> &
    Pick<TableFilterCondition, "column" | "operator">
): TableFilterCondition {
  return {
    id: 1,
    value: "",
    enabled: true,
    ...patch,
  };
}

describe("buildMongoFilter", () => {
  it("returns empty filter when nothing enabled", () => {
    expect(
      buildMongoFilter([
        filter({ column: "name", operator: "=", value: "a", enabled: false }),
      ])
    ).toEqual({});
  });

  it("equals numbers with type-flexible $in", () => {
    expect(
      buildMongoFilter([filter({ column: "age", operator: "=", value: "42" })])
    ).toEqual({ age: { $in: [42, "42"] } });
  });

  it("equals object ids with $oid plus string", () => {
    const id = "507f1f77bcf86cd799439011";
    expect(
      buildMongoFilter([filter({ column: "_id", operator: "=", value: id })])
    ).toEqual({
      _id: { $in: [{ $oid: id }, id] },
    });
  });

  it("maps contains / starts / ends / null operators", () => {
    expect(
      buildMongoFilter([
        filter({ column: "name", operator: "Contains", value: "foo.bar" }),
      ])
    ).toEqual({ name: { $regex: "foo\\.bar" } });

    expect(
      buildMongoFilter([
        filter({ column: "name", operator: "Starts with", value: "Al" }),
      ])
    ).toEqual({ name: { $regex: "^Al" } });

    expect(
      buildMongoFilter([
        filter({ column: "name", operator: "Ends with", value: "son" }),
      ])
    ).toEqual({ name: { $regex: "son$" } });

    expect(
      buildMongoFilter([filter({ column: "email", operator: "IS NULL" })])
    ).toEqual({ email: null });
  });

  it("combines AND / OR clauses", () => {
    const filters = [
      filter({ id: 1, column: "status", operator: "=", value: "active" }),
      filter({ id: 2, column: "age", operator: ">", value: "10" }),
    ];
    expect(buildMongoFilter(filters, "AND")).toEqual({
      $and: [{ status: "active" }, { age: { $gt: 10 } }],
    });
    expect(buildMongoFilter(filters, "OR")).toEqual({
      $or: [{ status: "active" }, { age: { $gt: 10 } }],
    });
  });

  it("maps LIKE and IN lists", () => {
    expect(
      buildMongoFilter([
        filter({ column: "name", operator: "LIKE", value: "A%" }),
      ])
    ).toEqual({ name: { $regex: "^A.*$" } });

    expect(
      buildMongoFilter([
        filter({ column: "status", operator: "IN", value: "a, b" }),
      ])
    ).toEqual({ status: { $in: ["a", "b"] } });
  });
});

describe("buildMongoSort", () => {
  it("maps asc/desc and ignores empty column", () => {
    expect(buildMongoSort({ colName: "createdAt", direction: "desc" })).toEqual(
      {
        createdAt: -1,
      }
    );
    expect(buildMongoSort({ colName: "name", direction: "asc" })).toEqual({
      name: 1,
    });
    expect(buildMongoSort(null)).toBeNull();
  });
});

describe("formatMongoFindPreview", () => {
  it("renders find + sort + skip + limit", () => {
    expect(
      formatMongoFindPreview({
        collection: "users",
        filters: [filter({ column: "name", operator: "=", value: "Ada" })],
        sortBy: { colName: "name", direction: "desc" },
        offset: 20,
        limit: 50,
      })
    ).toBe(
      'db.users.find({"name":"Ada"}).sort({"name":-1}).skip(20).limit(50)'
    );
  });
});
