import { describe, expect, it } from "vitest";
import {
  cloneTableSql,
  formatSqlValue,
  quoteIdentifier,
  quoteTableName,
  sqlForDisplay,
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
      { text: 'token"]}}', password: "p'ass\\word" },
      "json",
      "mysql"
    );

    expect(sql).toMatch(
      /^CONVERT\(UNHEX\('[0-9a-f]+'\) USING utf8mb4\) COLLATE utf8mb4_unicode_ci$/
    );
    expect(sql).not.toContain("p'ass");
    expect(sql).not.toContain('"]}}');
  });

  it("serializes base64 byte cells as MySQL binary literals", () => {
    expect(
      formatSqlValue({ t: "BytesB64", v: "AQID/w==" }, "blob", "mysql")
    ).toBe("X'010203ff'");
  });

  it("serializes edited blob hex text as MySQL binary literals", () => {
    expect(formatSqlValue("A1761FA5", "longblob", "mysql")).toBe("X'A1761FA5'");
  });

  it("renders MySQL hex literals as quoted strings for display", () => {
    const executed = `SELECT * FROM \`fleet\`.\`software\` WHERE CONVERT(\`name\` USING utf8mb4) COLLATE utf8mb4_unicode_ci LIKE CONVERT(UNHEX('2566697265666f7825') USING utf8mb4) COLLATE utf8mb4_unicode_ci LIMIT 300 OFFSET 0;`;
    expect(sqlForDisplay(executed, "mysql")).toBe(
      "SELECT * FROM `fleet`.`software` WHERE `name` LIKE '%firefox%' LIMIT 300 OFFSET 0;"
    );
  });

  it("renders Postgres decode literals as quoted strings for display", () => {
    const executed =
      "INSERT INTO users (avatar) VALUES (decode('48656c6c6f', 'hex'));";
    expect(sqlForDisplay(executed, "postgres")).toBe(
      "INSERT INTO users (avatar) VALUES ('Hello');"
    );
  });

  it("renders SQL Server literals in a friendlier form for display", () => {
    const executed =
      "UPDATE users SET name = N'O''Neil', token = 0x48656c6c6f WHERE id = 1;";
    expect(sqlForDisplay(executed, "sqlserver")).toBe(
      "UPDATE users SET name = 'O''Neil', token = 'Hello' WHERE id = 1;"
    );
  });

  it("renders Oracle HEXTORAW literals as quoted strings for display", () => {
    const executed =
      "INSERT INTO files (payload) VALUES (HEXTORAW('48656c6c6f'));";
    expect(sqlForDisplay(executed, "oracle")).toBe(
      "INSERT INTO files (payload) VALUES ('Hello');"
    );
  });

  it("renders MySQL blob literals as quoted strings for display", () => {
    const executed = "INSERT INTO files (payload) VALUES (X'48656c6c6f');";
    expect(sqlForDisplay(executed, "mysql")).toBe(
      "INSERT INTO files (payload) VALUES ('Hello');"
    );
  });

  it("leaves non-MySQL SQL unchanged for display", () => {
    const sql = "SELECT * FROM users WHERE name = 'firefox';";
    expect(sqlForDisplay(sql, "postgres")).toBe(sql);
  });

  it("is idempotent for already-friendly SQL", () => {
    const sql = "SELECT * FROM users WHERE name = '%firefox%';";
    expect(sqlForDisplay(sqlForDisplay(sql, "mysql"), "mysql")).toBe(sql);
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
    expect(() =>
      cloneTableSql("dbo", "Users", "UsersCopy", "sqlserver")
    ).toThrow("Clone table is not supported");
  });
});
