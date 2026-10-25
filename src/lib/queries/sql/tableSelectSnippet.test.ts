import { describe, expect, it } from "vitest";
import { tableSelectSnippet } from "./tableData";

describe("tableSelectSnippet", () => {
  it("limits rows the way each engine writes it", () => {
    expect(tableSelectSnippet("public", "users", "postgres")).toBe(
      'SELECT * FROM "public"."users" LIMIT 100;'
    );
    expect(tableSelectSnippet("shop", "order", "mysql")).toBe(
      "SELECT * FROM `shop`.`order` LIMIT 100;"
    );
    expect(tableSelectSnippet("dbo", "a]b", "sqlserver")).toBe(
      "SELECT TOP 100 * FROM [dbo].[a]]b];"
    );
    expect(tableSelectSnippet("HR", "EMP", "oracle")).toBe(
      'SELECT * FROM "HR"."EMP" FETCH FIRST 100 ROWS ONLY;'
    );
    expect(tableSelectSnippet("main", "notes", "sqlite")).toBe(
      'SELECT * FROM "notes" LIMIT 100;'
    );
  });
});
