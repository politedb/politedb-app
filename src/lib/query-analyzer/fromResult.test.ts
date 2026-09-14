import { describe, expect, it } from "vitest";
import { planFromResult } from "./fromResult";

describe("planFromResult for non-Postgres engines", () => {
  it("parses MySQL FORMAT=JSON tables as sequential scans", () => {
    const plan = planFromResult(
      "mysql",
      [{ name: "EXPLAIN" }],
      [
        [
          {
            t: "Json",
            v: JSON.stringify({
              query_block: {
                cost_info: { query_cost: "8.5" },
                table: {
                  table_name: "User",
                  access_type: "ALL",
                  rows_examined_per_scan: 188,
                  attached_condition: "id = 1",
                },
              },
            }),
          },
        ],
      ]
    );
    expect(plan?.nodes[0].label).toBe("Seq Scan on User");
    expect(plan?.actual).toBe(false);
    expect(plan?.analyzeHint).toContain("EXPLAIN ANALYZE");
  });

  it("builds a SQLite QUERY PLAN tree from parent ids", () => {
    const plan = planFromResult(
      "sqlite",
      [
        { name: "id" },
        { name: "parent" },
        { name: "notused" },
        { name: "detail" },
      ],
      [
        [
          { t: "I64", v: 2 },
          { t: "I64", v: 0 },
          { t: "I64", v: 0 },
          { t: "Str", v: "SCAN users" },
        ],
        [
          { t: "I64", v: 3 },
          { t: "I64", v: 2 },
          { t: "I64", v: 0 },
          { t: "Str", v: "SEARCH orders USING INDEX orders_user_id" },
        ],
      ]
    );
    expect(plan?.nodes.map((node) => [node.depth, node.label])).toEqual([
      [0, "SCAN users"],
      [1, "SEARCH orders USING INDEX orders_user_id"],
    ]);
  });

  it("parses SQL Server SHOWPLAN_ALL rows", () => {
    const plan = planFromResult(
      "sqlserver",
      [
        { name: "NodeId" },
        { name: "Parent" },
        { name: "PhysicalOp" },
        { name: "EstimateRows" },
        { name: "TotalSubtreeCost" },
      ],
      [
        [
          { t: "I64", v: 1 },
          { t: "I64", v: 0 },
          { t: "Str", v: "Clustered Index Scan" },
          { t: "F64", v: 188 },
          { t: "F64", v: 0.03 },
        ],
      ]
    );
    expect(plan?.nodes[0].type).toBe("Clustered Index Scan");
    expect(plan?.nodes[0].data["Total Cost"]).toBe(0.03);
  });

  it("parses Snowflake JSON operations", () => {
    const plan = planFromResult(
      "snowflake",
      [{ name: "plan" }],
      [
        [
          {
            t: "Json",
            v: JSON.stringify({
              Operations: [
                { id: 0, operation: "Result" },
                {
                  id: 1,
                  parent: 0,
                  operation: "TableScan",
                  objects: "PUBLIC.USER",
                },
              ],
            }),
          },
        ],
      ]
    );
    expect(plan?.nodes.map((node) => node.label)).toEqual([
      "Result",
      "TableScan on PUBLIC.USER",
    ]);
  });

  it("parses Oracle DBMS_XPLAN text", () => {
    const plan = planFromResult(
      "oracle",
      [{ name: "PLAN_TABLE_OUTPUT" }],
      [
        [
          {
            t: "Str",
            v: "| Id  | Operation           | Name | Rows  | Cost |",
          },
        ],
        [
          {
            t: "Str",
            v: "|   0 | SELECT STATEMENT    |      |     1 |    2 |",
          },
        ],
        [
          {
            t: "Str",
            v: "|   1 |  TABLE ACCESS FULL  | EMP  |     1 |    2 |",
          },
        ],
      ]
    );
    expect(plan?.nodes[1].label).toBe("TABLE ACCESS FULL on EMP");
    expect(plan?.nodes[1].depth).toBe(1);
  });

  it("opens the analyzer UI for any Explain rows when structured parse fails", () => {
    const plan = planFromResult(
      "mysql",
      [{ name: "EXPLAIN" }],
      [[{ t: "Str", v: "id = 1; type = ALL; table = User" }]],
      { fallback: true }
    );
    expect(plan?.nodes[0].label).toContain("User");
    expect(
      planFromResult("mysql", [{ name: "id" }], [[{ t: "I64", v: 1 }]])
    ).toBeNull();
    expect(
      planFromResult(
        "postgres",
        [{ name: "QUERY PLAN" }],
        [[{ t: "Json", v: "invalid" }]],
        { fallback: true }
      )
    ).toBeNull();
  });

  it("parses DuckDB EXPLAIN text as plan nodes", () => {
    const plan = planFromResult(
      "duckdb",
      [{ name: "physical_plan" }],
      [[{ t: "Str", v: "PROJECTION" }], [{ t: "Str", v: "  SEQ_SCAN users" }]]
    );
    expect(plan?.nodes.map((node) => [node.depth, node.label])).toEqual([
      [0, "PROJECTION"],
      [1, "SEQ_SCAN users"],
    ]);
  });
});
