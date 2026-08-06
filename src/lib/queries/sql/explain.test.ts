import { describe, expect, it } from "vitest";
import { buildExplainSql } from "./explain";

describe("buildExplainSql", () => {
  it("uses JSON explain for Postgres and EXPLAIN for other standard SQL engines", () => {
    expect(buildExplainSql("postgres", "select 1;")).toEqual({
      sql: "EXPLAIN (FORMAT JSON) select 1",
    });
    expect(buildExplainSql("mysql", "select 1")).toEqual({
      sql: "EXPLAIN select 1",
    });
    expect(buildExplainSql("snowflake", "select 1")).toEqual({
      sql: "EXPLAIN select 1",
    });
  });

  it("uses EXPLAIN QUERY PLAN for sqlite-family engines", () => {
    expect(buildExplainSql("sqlite", "select * from users;")).toEqual({
      sql: "EXPLAIN QUERY PLAN select * from users",
    });
    expect(buildExplainSql("d1", "select * from users")).toEqual({
      sql: "EXPLAIN QUERY PLAN select * from users",
    });
    expect(buildExplainSql("turso", "select * from users")).toEqual({
      sql: "EXPLAIN QUERY PLAN select * from users",
    });
  });

  it("returns an unsupported error for non-sql engines", () => {
    expect(buildExplainSql("mongo", "db.users.find()")).toEqual({
      error: "Explain is not supported for this engine yet.",
    });
  });
});
