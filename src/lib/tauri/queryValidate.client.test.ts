import { describe, expect, it } from "vitest";
import { validateSqlClient } from "./queryValidate";

describe("validateSqlClient", () => {
  const sql = String.raw`SELECT '\'; DELETE FROM t; --'`;

  it("splits PostgreSQL text by PostgreSQL rules", () => {
    // '\' is a whole string there: the DELETE is a statement of its own.
    expect(validateSqlClient(sql, "postgres")).toEqual({
      ok: true,
      statements: [String.raw`SELECT '\'`, "DELETE FROM t", "--'"],
    });
  });

  it("keeps backslash escapes for other engines", () => {
    expect(validateSqlClient(sql, "mysql")).toEqual({
      ok: true,
      statements: [sql],
    });
  });
});
