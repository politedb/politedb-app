import { describe, expect, it } from "vitest";
import { maskSql } from "./sqlLexer";
import { cursorScopes } from "./sqlScope";

describe("maskSql", () => {
  it("keeps offsets and hides literals and comments", () => {
    const sql = "SELECT 'a;b', \"x;y\" -- c;\nFROM t; SELECT 1";
    const masked = maskSql(sql, {});
    expect(masked.text).toHaveLength(sql.length);
    expect(masked.text).toContain("'___'");
    expect(masked.text).toContain('"x;y"');
    expect(masked.text).not.toContain("c;");
    expect(masked.semicolons).toEqual([sql.indexOf("; SELECT 1")]);
  });

  it("reports where the cursor is", () => {
    const sql = "SELECT 'ab' /* c */ x";
    expect(maskSql(sql, {}, sql.indexOf("b")).cursorIn).toBe("literal");
    expect(maskSql(sql, {}, sql.indexOf("'", 8) + 1).cursorIn).toBe("code");
    expect(maskSql(sql, {}, sql.indexOf("c")).cursorIn).toBe("comment");
    expect(maskSql(sql, {}, sql.length).cursorIn).toBe("code");
  });

  it("follows dialect rules", () => {
    const pg = {
      dollarQuotes: true,
      nestedComments: true,
      escapeStrings: true,
    };
    expect(maskSql("$a$ ; $a$;", pg).semicolons).toEqual([9]);
    expect(maskSql("/* /* ; */ ; */;", pg).semicolons).toEqual([15]);
    expect(maskSql("/* /* */ ;", {}).semicolons).toEqual([9]);
    expect(maskSql("E'\\';';", pg).semicolons).toEqual([6]);
    expect(maskSql("x#;\n;", { hashComments: true }).semicolons).toEqual([4]);
    expect(maskSql("[a;]]b];", { brackets: true }).semicolons).toEqual([7]);
    expect(maskSql("a$1;", pg).semicolons).toEqual([3]);
  });
});

describe("cursorScopes", () => {
  const scopes = (sql: string, cursor: number) => {
    const masked = maskSql(sql, {});
    return cursorScopes(masked.text, masked.keywords, cursor);
  };

  it("blanks subqueries and other UNION branches", () => {
    const sql =
      "SELECT a FROM t WHERE x IN (SELECT b FROM u) UNION SELECT c FROM v";
    const [root] = scopes(sql, sql.indexOf("a FROM"));
    expect(root!.text).toContain("FROM t");
    expect(root!.text).not.toContain("FROM u");
    expect(root!.text).not.toContain("FROM v");
    const inner = scopes(sql, sql.indexOf("b FROM"));
    expect(inner).toHaveLength(2);
    expect(inner[1]!.text).toContain("FROM u");
    expect(inner[1]!.text).not.toContain("FROM t");
  });

  it("finds keywords outside quoted names only", () => {
    const sql = 'SELECT "union", "(select" FROM t';
    const [root] = scopes(sql, 7);
    expect(root!.text).toBe(sql);
    expect(root!.keywords).toBe('SELECT "_____", "_______" FROM t');
  });

  it("stays fast for deeply nested subqueries", () => {
    let sql = "SELECT 1 FROM t WHERE ";
    for (let i = 0; i < 400; i++) sql += "EXISTS (SELECT 1 FROM t WHERE ";
    sql += "x" + ")".repeat(400);
    const started = performance.now();
    const chain = scopes(sql, sql.indexOf("x"));
    expect(chain).toHaveLength(401);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("does work linear in the statement for dense nesting", () => {
    const depth = 20_000;
    const sql =
      "SELECT (".repeat(depth) + "SELECT x FROM t" + ")".repeat(depth);
    const started = performance.now();
    const chain = scopes(sql, sql.indexOf("x FROM"));
    expect(chain).toHaveLength(depth + 1);
    expect(chain[depth]!.text).toContain("FROM t");
    // Each outer scope holds its own text and one space for its subquery.
    expect(chain[1]!.text).toBe("SELECT ( )");
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("keeps the cursor's branch when subqueries are shrunk", () => {
    const sql =
      "SELECT a FROM (SELECT b FROM u) t UNION SELECT c FROM (SELECT d FROM w) v WHERE x";
    const [root] = scopes(sql, sql.indexOf("WHERE x"));
    expect(root!.text).toContain("FROM ( ) v WHERE x");
    expect(root!.text).not.toContain("SELECT a");
    const [first] = scopes(sql, sql.indexOf("a FROM"));
    expect(first!.text).toContain("SELECT a FROM ( ) t");
    expect(first!.text).not.toContain("SELECT c");
  });
});
