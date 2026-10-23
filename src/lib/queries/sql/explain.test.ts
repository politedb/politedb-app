import { describe, expect, it } from "vitest";
import {
  buildExplainSql,
  hasPositionalParameters,
  isPlanStatement,
  leadingSqlKeyword,
} from "./explain";

describe("buildExplainSql", () => {
  it("returns the unwrapped statement alongside the wrapper", () => {
    expect(
      buildExplainSql("postgres", "-- top\nselect 1; -- tail").source
    ).toBe("-- top\nselect 1");
  });

  it("uses JSON explain for engines that return structured plans", () => {
    expect(buildExplainSql("postgres", "select 1;")).toEqual({
      statements: ["EXPLAIN (FORMAT JSON) select 1"],
      source: "select 1",
    });
    expect(buildExplainSql("mysql", "select 1")).toEqual({
      statements: ["EXPLAIN FORMAT=JSON select 1"],
      source: "select 1",
    });
    expect(buildExplainSql("snowflake", "select 1")).toEqual({
      statements: ["EXPLAIN USING JSON select 1"],
      source: "select 1",
    });
    expect(buildExplainSql("clickhouse", "select 1")).toEqual({
      statements: ["EXPLAIN json=1 select 1"],
      source: "select 1",
    });
  });

  it("uses EXPLAIN QUERY PLAN for sqlite-family engines", () => {
    expect(buildExplainSql("sqlite", "select * from users;")).toEqual({
      statements: ["EXPLAIN QUERY PLAN select * from users"],
      source: "select * from users",
    });
    expect(buildExplainSql("d1", "select * from users")).toEqual({
      statements: ["EXPLAIN QUERY PLAN select * from users"],
      source: "select * from users",
    });
    expect(buildExplainSql("turso", "select * from users")).toEqual({
      statements: ["EXPLAIN QUERY PLAN select * from users"],
      source: "select * from users",
    });
  });

  it("uses SHOWPLAN / PLAN_TABLE batches for SQL Server and Oracle", () => {
    expect(buildExplainSql("sqlserver", "select 1")).toEqual({
      statements: ["SET SHOWPLAN_ALL ON;\nselect 1;\nSET SHOWPLAN_ALL OFF;"],
    });
    expect(buildExplainSql("oracle", "select 1 from dual")).toEqual({
      statements: [
        "EXPLAIN PLAN FOR select 1 from dual",
        "SELECT PLAN_TABLE_OUTPUT FROM TABLE(DBMS_XPLAN.DISPLAY())",
      ],
    });
  });

  it("returns a specific error for engines without query plans", () => {
    expect(buildExplainSql("mongo", "db.users.find()").error).toMatch(
      /MongoDB/
    );
    expect(buildExplainSql("redis", "GET k").error).toMatch(/Redis/);
    expect(buildExplainSql("cassandra", "select 1").error).toMatch(/Cassandra/);
    expect(buildExplainSql("google_sheets", "select 1").error).toMatch(
      /Google Sheets/
    );
  });

  it("explains one statement at a time", () => {
    expect(buildExplainSql("postgres", "select 1; select 2;").error).toMatch(
      /one statement at a time/
    );
    // Semicolons inside strings and comments are not separators.
    expect(
      buildExplainSql("postgres", "select ';' -- a; b\nfrom t").statements
    ).toEqual(["EXPLAIN (FORMAT JSON) select ';' -- a; b\nfrom t"]);
  });

  it("does not wrap an EXPLAIN again", () => {
    for (const sql of [
      "EXPLAIN select 1",
      "  /* note */ explain (analyze) select 1",
      "-- plan\nExplain select 1",
    ]) {
      expect(buildExplainSql("postgres", sql).error).toMatch(
        /already an EXPLAIN/
      );
    }
  });

  it("refuses PostgreSQL positional parameters with a clear message", () => {
    expect(
      buildExplainSql("postgres", "select * from t where id = $1").error
    ).toMatch(/parameters/);
    // $1 elsewhere does not count.
    for (const sql of [
      "select '$1' from t",
      'select "$1" from t',
      "select 1 -- $1",
      "select $$ $1 $$",
      "select $tag$ $1 $tag$",
      "select price$1 from t",
    ]) {
      expect(hasPositionalParameters(sql), sql).toBe(false);
    }
    expect(
      hasPositionalParameters("select * from t where a = $2 and b = 1")
    ).toBe(true);
    // Other engines keep their own placeholder rules.
    expect(buildExplainSql("mysql", "select $1").statements).toBeDefined();
  });

  it("reads the leading keyword past comments", () => {
    expect(
      leadingSqlKeyword("  -- x\n /* y */ with a as (select 1) select 1")
    ).toBe("WITH");
    expect(leadingSqlKeyword("")).toBe("");
  });

  it("follows PostgreSQL lexical rules", () => {
    for (const sql of [
      "select $tag1$ $1 $tag1$",
      "select E'it\\'s $1'",
      "select 1 /* outer /* inner */ $1 */",
      "select U&'d\\0061t$1'",
    ]) {
      expect(hasPositionalParameters(sql), sql).toBe(false);
    }
    // An escaped quote must not hide a real parameter after the string.
    expect(hasPositionalParameters("select E'a\\'b', $1")).toBe(true);
    expect(
      leadingSqlKeyword("/* a /* nested */ still comment */ EXPLAIN select 1")
    ).toBe("EXPLAIN");
  });

  it("ignores comment-only tails and keeps the statement intact", () => {
    for (const engine of ["postgres", "mysql"] as const) {
      expect(
        buildExplainSql(engine, "select 1; -- note").statements?.[0]
      ).toMatch(/select 1$/);
      expect(
        buildExplainSql(engine, "select 1; /* note */").statements?.[0]
      ).toMatch(/select 1$/);
    }
    // A trailing comment on the same line is not wrapped into the EXPLAIN.
    expect(
      buildExplainSql("postgres", "-- why\nselect 1 -- trailing").statements
    ).toEqual(["EXPLAIN (FORMAT JSON) -- why\nselect 1"]);
    expect(
      buildExplainSql("postgres", "select 1; select 2 -- x").error
    ).toMatch(/one statement at a time/);
  });

  it("refuses unreadable PostgreSQL input", () => {
    for (const sql of ["select 'open", "select /* open", "select $a$ open"]) {
      expect(buildExplainSql("postgres", sql).error, sql).toMatch(/not closed/);
    }
  });
});

describe("engine plan statements", () => {
  it("asks DuckDB for a JSON plan", () => {
    expect(buildExplainSql("duckdb", "select 1;")).toEqual({
      statements: ["EXPLAIN (FORMAT JSON) select 1"],
      source: "select 1",
    });
  });

  it("recognizes plan statements typed by the user", () => {
    expect(isPlanStatement("mysql", "/* x */ explain analyze select 1")).toBe(
      true
    );
    expect(isPlanStatement("mariadb", "ANALYZE FORMAT=JSON select 1")).toBe(
      true
    );
    // Only MariaDB's ANALYZE returns a plan; ANALYZE TABLE never does.
    expect(isPlanStatement("mariadb", "ANALYZE TABLE t")).toBe(false);
    expect(isPlanStatement("mysql", "ANALYZE FORMAT=JSON select 1")).toBe(
      false
    );
    expect(isPlanStatement("postgres", "select 1")).toBe(false);
  });

  it("refuses to wrap a MariaDB ANALYZE in another EXPLAIN", () => {
    expect(
      buildExplainSql("mariadb", "ANALYZE FORMAT=JSON select 1").error
    ).toMatch(/already an EXPLAIN/);
  });
});
