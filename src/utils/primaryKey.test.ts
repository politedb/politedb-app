import { describe, expect, it } from "vitest";
import {
  cellIsTruthy,
  isPrimaryKeyColumn,
  primaryKeyColumnsFromConstraints,
  resolvePrimaryKeyColumns,
  findPrimaryKeyConstraint,
} from "./primaryKey";

describe("cellIsTruthy", () => {
  it.each([
    [true, true],
    [1, true],
    ["true", true],
    ["TRUE", true],
    ["1", true],
    ["t", true],
    ["yes", true],
    [{ t: "Bool", v: true }, true],
    [{ t: "I64", v: 1 }, true],
    [{ t: "Str", v: "1" }, true],
    [false, false],
    [0, false],
    ["false", false],
    ["0", false],
    [{ t: "I64", v: 0 }, false],
    [{ t: "Bool", v: false }, false],
    [{ t: "Null" }, false],
    [null, false],
  ])("%j → %s", (input, expected) => {
    expect(cellIsTruthy(input)).toBe(expected);
  });
});

describe("resolvePrimaryKeyColumns", () => {
  it("detects MySQL PRIMARY by index_name when the flag is missing", () => {
    expect(
      primaryKeyColumnsFromConstraints([
        { index_name: "PRIMARY", is_unique: true, column_name: "id" },
      ])
    ).toEqual(["id"]);
  });

  it("trusts an explicit false flag even on an index named PRIMARY", () => {
    // PostgreSQL allows CONSTRAINT "PRIMARY" UNIQUE (email); the MySQL
    // loader always flags its PRIMARY index, so false is authoritative.
    expect(
      primaryKeyColumnsFromConstraints([
        {
          index_name: "PRIMARY",
          is_unique: true,
          is_primary: false,
          column_name: "email",
        },
      ])
    ).toEqual([]);
  });

  it("detects MySQL is_primary from numeric and string 1 flags", () => {
    expect(
      primaryKeyColumnsFromConstraints([
        {
          index_name: "users_deleted_id_uq",
          is_unique: true,
          is_primary: 1 as never,
          column_name: "id",
        },
      ])
    ).toEqual(["id"]);
  });

  it("falls back to column is_primary when constraints are missing", () => {
    expect(
      resolvePrimaryKeyColumns({
        constraints: null,
        columns: [
          { name: "name", is_primary: false },
          { name: "id", is_primary: { t: "I64", v: 1 } },
        ],
      })
    ).toEqual(["id"]);
  });

  it("matches PK columns case-insensitively and strips quotes", () => {
    expect(isPrimaryKeyColumn("id", ["`ID`"])).toBe(true);
    expect(isPrimaryKeyColumn("created_at", ["id"])).toBe(false);
  });

  it("parses composite MySQL PRIMARY column lists", () => {
    expect(
      primaryKeyColumnsFromConstraints([
        {
          index_name: "PRIMARY",
          is_unique: true,
          is_primary: true,
          column_name: "org_id,user_id",
        },
      ])
    ).toEqual(["org_id", "user_id"]);
  });
});

describe("findPrimaryKeyConstraint", () => {
  it("takes the flagged row over a UNIQUE index named like a key", () => {
    const decoys = [
      {
        index_name: "primary_email",
        column_name: "email",
        is_unique: true,
        is_primary: false,
      },
      {
        index_name: "orders_legacy_pkey",
        column_name: "legacy_id",
        is_unique: true,
        is_primary: false,
      },
      {
        index_name: "items_main",
        column_name: "id",
        is_unique: true,
        is_primary: true,
      },
    ];
    expect(findPrimaryKeyConstraint(decoys)?.index_name).toBe("items_main");
    expect(primaryKeyColumnsFromConstraints(decoys)).toEqual(["id"]);
  });

  it("never guesses by name when rows carry the flag", () => {
    expect(
      findPrimaryKeyConstraint([
        {
          index_name: "orders_legacy_pkey",
          column_name: "legacy_id",
          is_unique: true,
          is_primary: false,
        },
      ])
    ).toBeUndefined();
  });

  it("guesses by name only for metadata without the flag", () => {
    expect(
      findPrimaryKeyConstraint([
        {
          index_name: "users_email_key",
          column_name: "email",
          is_unique: true,
        },
        { index_name: "users_pkey", column_name: "id", is_unique: true },
      ])?.index_name
    ).toBe("users_pkey");
  });
});
