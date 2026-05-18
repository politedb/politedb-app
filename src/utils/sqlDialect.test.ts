import { describe, expect, it } from "vitest";
import {
  cloneTableSql,
  formatSqlValue,
  quoteIdentifier,
  quoteTableName,
  truncateTableSql,
} from "./sqlDialect";
import { formatSqlChunk } from "./exportFormats";

describe("sqlDialect", () => {
  it("quotes identifiers by engine", () => {
    expect(quoteTableName("public", "users", "postgres")).toBe(
      '"public"."users"'
    );
    expect(quoteTableName("fleet", "app_config_json", "mysql")).toBe(
      "`fleet`.`app_config_json`"
    );
    expect(quoteTableName("dbo", "Users", "sqlserver")).toBe("[dbo].[Users]");
    expect(quoteTableName("main", "users", "sqlite")).toBe('"users"');
    expect(quoteIdentifier("a]b", "sqlserver")).toBe("[a]]b]");
  });

  it("serializes MySQL JSON values without raw quote/backslash syntax hazards", () => {
    const sql = formatSqlValue(
      { text: "token\"]}}", password: "p'ass\\word" },
      "json",
      "mysql"
    );

    expect(sql).toMatch(/^CONVERT\(UNHEX\('[0-9a-f]+'\) USING utf8mb4\)$/);
    expect(sql).not.toContain("p'ass");
    expect(sql).not.toContain('"]}}');
  });

  it("exports SQL using the selected engine dialect", () => {
    const sql = formatSqlChunk(
      "fleet",
      "app_config_json",
      ["id", "json_value"],
      [[1, '{"ok":true}']],
      "mysql"
    );

    expect(sql).toContain("INSERT INTO `fleet`.`app_config_json`");
    expect(sql).toContain("`json_value`");
    expect(sql).toContain("CONVERT(UNHEX(");
  });

  it("builds table action SQL by engine", () => {
    expect(cloneTableSql("public", "users", "users_copy", "postgres")).toBe(
      'CREATE TABLE "public"."users_copy" (LIKE "public"."users" INCLUDING ALL);'
    );
    expect(cloneTableSql("app", "users", "users_copy", "mysql")).toBe(
      "CREATE TABLE `app`.`users_copy` LIKE `app`.`users`;"
    );
    expect(truncateTableSql("main", "users", undefined, "sqlite")).toBe(
      'DELETE FROM "users";'
    );
  });

  it("throws for unsupported table actions instead of generating unsafe SQL", () => {
    expect(() => cloneTableSql("dbo", "Users", "UsersCopy", "sqlserver")).toThrow(
      "Clone table is not supported"
    );
  });
});
