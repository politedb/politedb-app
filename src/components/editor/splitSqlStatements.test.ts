import { describe, it, expect } from "vitest";
import { splitSqlStatements } from "./splitSqlStatements";

describe("splitSqlStatements", () => {
  it("splits simple statements by semicolon", () => {
    const sql = "select 1; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select 1", "select 2"]);
  });

  it("ignores empty statements and trims whitespace", () => {
    const sql = "  ; \n  select 1  ;  ;  ";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select 1"]);
  });

  it("does not split on semicolons inside single-quoted strings", () => {
    const sql = "select ';' as x; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select ';' as x", "select 2"]);
  });

  it("handles escaped single quotes (''), still not splitting", () => {
    const sql = "select 'it''s; ok' as x; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select 'it''s; ok' as x", "select 2"]);
  });

  it("does not split on semicolons inside double-quoted identifiers", () => {
    const sql = 'select "a;bc" as col; select 2;';
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(['select "a;bc" as col', "select 2"]);
  });

  it('handles escaped double quotes (""), still not splitting', () => {
    const sql = 'select "a"";b" as col; select 2;';
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(['select "a"";b" as col', "select 2"]);
  });

  it("does not split on semicolons inside backticks (MySQL identifiers)", () => {
    const sql = "select `a;bc` as col; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select `a;bc` as col", "select 2"]);
  });

  it("handles escaped backticks (``) inside backticks", () => {
    const sql = "select `a``;b` as col; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select `a``;b` as col", "select 2"]);
  });

  it("does not split on semicolons inside line comments --", () => {
    const sql = "select 1 -- comment ; still comment\n; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select 1 -- comment ; still comment", "select 2"]);
  });

  it("does not split on semicolons inside block comments /* */", () => {
    const sql = "select 1 /* comment ; inside */; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select 1 /* comment ; inside */", "select 2"]);
  });

  it("supports Postgres dollar-quoted strings $$ ... $$", () => {
    const sql = "select $$hello;world$$; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select $$hello;world$$", "select 2"]);
  });

  it("supports Postgres tagged dollar-quoted strings $tag$ ... $tag$", () => {
    const sql = "select $abc$hello;world$abc$; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select $abc$hello;world$abc$", "select 2"]);
  });

  it("does not treat invalid $-tag as dollar quote", () => {
    // $a-b$ is invalid by your scanner (dash not allowed) => should split at ;
    const sql = "select $a-b$hello;world$a-b$; select 2;";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select $a-b$hello", "world$a-b$", "select 2"]);
  });

  it("keeps correct start/end offsets for each statement", () => {
    const sql = "  select 1; \nselect 2;";
    const out = splitSqlStatements(sql);

    expect(out).toHaveLength(2);

    // statement 1: "  select 1" ends right before first ';'
    expect(out[0].text).toBe("select 1");
    expect(sql.slice(out[0].start, out[0].end)).toBe("  select 1");

    // statement 2: starts after ';' (and includes whitespace/newline in raw slice)
    expect(out[1].text).toBe("select 2");
    expect(sql.slice(out[1].start, out[1].end).trim()).toBe("select 2");
  });

  it("works with no trailing semicolon", () => {
    const sql = "select 1; select 2";
    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toEqual(["select 1", "select 2"]);
  });

  it("handles multi-line + mixed quotes/comments", () => {
    const sql = `
      select 'a;''b' as x, "c;""d" as y /* block; */ from t; -- line;
      select $$x;y$$ as z;
      select \`m;\`\`n\` as k;
    `;
    const out = splitSqlStatements(sql).map((s) => s.text);
    const norm = (x: string) => x.replace(/\r\n/g, "\n").trim();
    expect(out.map(norm)).toEqual([
      `select 'a;''b' as x, "c;""d" as y /* block; */ from t`,
      `-- line;
      select $$x;y$$ as z`,
      "select `m;``n` as k",
    ]);
  });

  it("does not split on semicolon inside MySQL escaped JSON string", () => {
    const sql = [
      "UPDATE `t`",
      'SET `json_value` = \'{\\"decorators\\":{\\"load\\":[\\"SELECT hostname AS hostname FROM system_info;\\"]}}\';',
      "select * from `t`;",
    ].join("\n");

    const out = splitSqlStatements(sql).map((s) => s.text);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("system_info;");
    expect(out[1]).toBe("select * from `t`");
  });
});

describe("splitSqlStatements for PostgreSQL", () => {
  const pg = (sql: string) =>
    splitSqlStatements(sql, { dialect: "postgres" }).map((s) => s.text);

  it("never lets a backslash in data end a string early", () => {
    // A dump row whose first value is a single backslash: PostgreSQL reads
    // '\' as a whole string, so the ";" inside the second value is data.
    const sql = String.raw`INSERT INTO "public"."t" ("a","b") VALUES ('\', ';DROP TABLE victim;--');
SELECT 1;`;
    expect(pg(sql)).toEqual([
      String.raw`INSERT INTO "public"."t" ("a","b") VALUES ('\', ';DROP TABLE victim;--')`,
      "SELECT 1",
    ]);
  });

  it("keeps backslash escapes in E-strings", () => {
    expect(pg(String.raw`SELECT E'it\'s; ok'; SELECT 2;`)).toEqual([
      String.raw`SELECT E'it\'s; ok'`,
      "SELECT 2",
    ]);
    expect(pg(String.raw`SELECT e'a\\'; SELECT 2;`)).toEqual([
      String.raw`SELECT e'a\\'`,
      "SELECT 2",
    ]);
  });

  it("does not take a name ending in E for an E-string", () => {
    expect(pg(String.raw`SELECT type'a\'; SELECT 2;`)).toEqual([
      String.raw`SELECT type'a\'`,
      "SELECT 2",
    ]);
  });

  it("reads a backslash in a quoted identifier as text", () => {
    expect(pg(String.raw`CREATE TYPE "a\" AS ENUM ('x'); SELECT 2;`)).toEqual([
      String.raw`CREATE TYPE "a\" AS ENUM ('x')`,
      "SELECT 2",
    ]);
  });

  it("follows nested block comments", () => {
    expect(pg("/* a /* b; */ c; */ SELECT 1; SELECT 2;")).toEqual([
      "/* a /* b; */ c; */ SELECT 1",
      "SELECT 2",
    ]);
  });

  it("keeps the backslash escapes of other engines by default", () => {
    const sql = String.raw`INSERT INTO t VALUES ('a\'b;c'); SELECT 2;`;
    expect(splitSqlStatements(sql).map((s) => s.text)).toEqual([
      String.raw`INSERT INTO t VALUES ('a\'b;c')`,
      "SELECT 2",
    ]);
  });
});
