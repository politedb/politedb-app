import { describe, expect, it } from "vitest";
import { buildExplainSql } from "./explain";

describe("buildExplainSql", () => {
  it("uses JSON explain for engines that return structured plans", () => {
    expect(buildExplainSql("postgres", "select 1;")).toEqual({
      statements: ["EXPLAIN (FORMAT JSON) select 1"],
    });
    expect(buildExplainSql("mysql", "select 1")).toEqual({
      statements: ["EXPLAIN FORMAT=JSON select 1"],
    });
    expect(buildExplainSql("snowflake", "select 1")).toEqual({
      statements: ["EXPLAIN USING JSON select 1"],
    });
    expect(buildExplainSql("clickhouse", "select 1")).toEqual({
      statements: ["EXPLAIN json=1 select 1"],
    });
  });

  it("uses EXPLAIN QUERY PLAN for sqlite-family engines", () => {
    expect(buildExplainSql("sqlite", "select * from users;")).toEqual({
      statements: ["EXPLAIN QUERY PLAN select * from users"],
    });
    expect(buildExplainSql("d1", "select * from users")).toEqual({
      statements: ["EXPLAIN QUERY PLAN select * from users"],
    });
    expect(buildExplainSql("turso", "select * from users")).toEqual({
      statements: ["EXPLAIN QUERY PLAN select * from users"],
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
});
