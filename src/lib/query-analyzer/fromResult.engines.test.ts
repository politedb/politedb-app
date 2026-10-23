import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { DatabaseEngine } from "src/types";
import { planFromResult } from "./fromResult";
import { planHeat, planNumber } from "./plan";

// Real outputs captured from disposable servers (MySQL 8.0.46 / 8.4.13 /
// 9.7.4, MariaDB 11.8.9, DuckDB 1.5.2) for the same small join.
const fixture = (name: string) =>
  readFileSync(
    resolve(__dirname, "../../test/fixtures/engine-plans", name),
    "utf8"
  );

function oneCell(engine: DatabaseEngine, file: string) {
  return planFromResult(
    engine,
    [{ name: "EXPLAIN" }],
    [[{ t: "Str", v: fixture(file) }]]
  )!;
}

function duckdb(key: string, file: string) {
  return planFromResult(
    "duckdb",
    [{ name: "explain_key" }, { name: "explain_value" }],
    [
      [
        { t: "Str", v: key },
        { t: "Str", v: fixture(file) },
      ],
    ]
  )!;
}

const labels = (plan: { nodes: { label: string; depth: number }[] }) =>
  plan.nodes.map((node) => `${node.depth}:${node.label}`);

describe("MySQL plans", () => {
  it("reads the classic JSON format (8.0 / 8.4)", () => {
    const plan = oneCell("mysql", "mysql80-explain.json");
    expect(plan.actual).toBe(false);
    expect(plan.nodes.map((node) => node.type)).toContain("Seq Scan");
  });

  it("reads JSON format version 2 (the MySQL 9 default)", () => {
    for (const file of ["mysql9-explain.json", "mysql84-explain-v2.json"]) {
      const plan = oneCell("mysql", file);
      expect(plan.actual).toBe(false);
      // 9.x prints "(id = o.cid)", 8.4 "(id=o.cid)".
      expect(labels(plan).map((label) => label.replace(/ = o/, "=o"))).toEqual([
        "0:Sort: count(*) DESC",
        "1:Table scan on <temporary>",
        "2:Aggregate using temporary table",
        "3:Nested loop inner join",
        "4:Filter: ((o.`status` = 'x') and (o.cid is not null))",
        "5:Table scan on o",
        "4:Single-row index lookup on c using PRIMARY (id=o.cid)",
      ]);
      const scan = plan.nodes[5]!;
      expect(scan.data["Relation Name"]).toBe("o");
      expect(planNumber(scan.data, "Plan Rows")).toBe(4);
      expect(planNumber(scan.data, "Total Cost")).toBe(0.65);
      expect(plan.nodes[6]!.data["Index Name"]).toBe("PRIMARY");
    }
  });

  it("reads EXPLAIN ANALYZE FORMAT=JSON (version 2) as measured", () => {
    const plan = oneCell("mysql", "mysql9-explain-analyze.json");
    expect(plan.actual).toBe(true);
    const lookup = plan.nodes.find((node) => node.data["Index Name"])!;
    expect(lookup.label).toMatch(/^Single-row index lookup/);
    expect(plan.nodes[2]!.data["Index Name"]).toBeUndefined();
    expect(planNumber(lookup.data, "Actual Loops")).toBe(2);
    expect(planNumber(lookup.data, "Actual Rows")).toBe(1);
    expect(planHeat(plan).kind).toBe("time");
  });

  it("reads EXPLAIN ANALYZE tree text as measured", () => {
    const plan = oneCell("mysql", "mysql80-explain-analyze.txt");
    expect(plan.actual).toBe(true);
    expect(labels(plan)).toEqual([
      "0:Sort: `count(*)` DESC",
      "1:Table scan on <temporary>",
      "2:Aggregate using temporary table",
      "3:Nested loop inner join",
      "4:Filter: ((o.`status` = 'x') and (o.cid is not null))",
      "5:Table scan on o",
      "4:Single-row index lookup on c using PRIMARY (id=o.cid)",
    ]);
    const scan = plan.nodes[5]!;
    expect(scan.type).toBe("Table scan");
    expect(scan.data["Relation Name"]).toBe("o");
    expect(planNumber(scan.data, "Total Cost")).toBe(0.65);
    expect(planNumber(scan.data, "Actual Rows")).toBe(4);
    expect(planNumber(scan.data, "Actual Total Time")).toBe(0.0238);
    expect(planNumber(plan.nodes[6]!.data, "Actual Loops")).toBe(2);
    expect(plan.nodes[4]!.data.Filter).toBe(
      "((o.`status` = 'x') and (o.cid is not null))"
    );
  });

  it("keeps a long condition that wraps onto the next line", () => {
    const plan = planFromResult(
      "mysql",
      [{ name: "EXPLAIN" }],
      [
        [
          {
            t: "Str",
            v: "-> Filter: (a = 1)\nand (b = 2)  (cost=1 rows=1)\n    -> Table scan on t  (cost=1 rows=1)",
          },
        ],
      ]
    )!;
    expect(plan.nodes).toHaveLength(2);
    expect(plan.nodes[0]!.label).toContain("and (b = 2)");
  });
});

describe("MariaDB plans", () => {
  it("reads EXPLAIN FORMAT=JSON with filesort and temporary table", () => {
    const plan = oneCell("mariadb", "mariadb11-explain.json");
    expect(plan.actual).toBe(false);
    expect(labels(plan)).toEqual([
      "0:filesort",
      "1:temporary table",
      "2:Nested Loop",
      "3:Seq Scan on o",
      "3:eq_ref on c using PRIMARY",
    ]);
    expect(planNumber(plan.nodes[3]!.data, "Total Cost")).toBe(0.0115068);
  });

  it("reads ANALYZE FORMAT=JSON as measured, per loop", () => {
    const plan = oneCell("mariadb", "mariadb11-analyze.json");
    expect(plan.actual).toBe(true);
    const lookup = plan.nodes[4]!;
    expect(planNumber(lookup.data, "Actual Loops")).toBe(2);
    expect(planNumber(lookup.data, "Actual Rows")).toBe(1);
    // (r_table_time_ms + r_other_time_ms) / r_loops
    expect(planNumber(lookup.data, "Actual Total Time")).toBeCloseTo(
      (0.011257339 + 0.049088695) / 2
    );
    const sort = plan.nodes[0]!;
    expect(planNumber(sort.data, "Actual Total Time")).toBeCloseTo(1.723209897);
  });

  it("keeps filesort rows, already an average per run", () => {
    const plan = planFromResult(
      "mariadb",
      [{ name: "ANALYZE" }],
      [
        [
          {
            t: "Str",
            v: JSON.stringify({
              query_block: {
                filesort: {
                  r_loops: 10,
                  r_output_rows: 100,
                  r_total_time_ms: 50,
                  table: {
                    table_name: "t",
                    access_type: "ALL",
                    r_loops: 10,
                    r_rows: 100,
                  },
                },
              },
            }),
          },
        ],
      ]
    )!;
    expect(planNumber(plan.nodes[0]!.data, "Actual Rows")).toBe(100);
    expect(planNumber(plan.nodes[0]!.data, "Actual Loops")).toBe(10);
    expect(planNumber(plan.nodes[0]!.data, "Actual Total Time")).toBe(5);
  });

  it("charges the sort only with its own time, not its subtree", () => {
    const plan = oneCell("mariadb", "mariadb11-analyze.json");
    const heat = planHeat(plan);
    expect(heat.kind).toBe("time");
    const [sort, temporary, loop, scan, lookup] = heat.nodes;
    // The structural nodes carry their children's time, flagged as derived.
    expect(plan.nodes[1]!.data["Derived Time"]).toBe(true);
    expect(plan.nodes[2]!.data["Derived Time"]).toBe(true);
    expect(temporary!.self).toBeCloseTo(0);
    expect(loop!.self).toBeCloseTo(0);
    const tables = scan!.inclusive! + lookup!.inclusive!;
    expect(sort!.self).toBeCloseTo(1.723209897 - tables);
    expect(sort!.selfShare).toBeLessThan(1);
    expect(scan!.selfShare + lookup!.selfShare).toBeGreaterThan(0);
  });

  it("does not bridge a node that reports its own loops", () => {
    const plan = planFromResult(
      "mysql",
      [{ name: "EXPLAIN" }],
      [
        [
          {
            t: "Str",
            v: JSON.stringify({
              query_block: {
                table: {
                  table_name: "t",
                  access_type: "ALL",
                  actual_rows: 3,
                  actual_loops: 10,
                  materialized_from_subquery: {
                    query_block: {
                      table: {
                        table_name: "s",
                        access_type: "ALL",
                        r_loops: 1,
                        r_rows: 2,
                        r_total_time_ms: 4,
                      },
                    },
                  },
                },
              },
            }),
          },
        ],
      ]
    )!;
    expect(planNumber(plan.nodes[0]!.data, "Actual Loops")).toBe(10);
    expect(plan.nodes[0]!.data["Actual Total Time"]).toBeUndefined();
  });

  it("measures a join without a sort by time", () => {
    const plan = planFromResult(
      "mariadb",
      [{ name: "ANALYZE" }],
      [
        [
          {
            t: "Str",
            v: JSON.stringify({
              query_block: {
                nested_loop: [
                  {
                    table: {
                      table_name: "a",
                      access_type: "ALL",
                      r_loops: 1,
                      r_rows: 3,
                      r_table_time_ms: 2,
                      r_other_time_ms: 1,
                    },
                  },
                  {
                    table: {
                      table_name: "b",
                      access_type: "eq_ref",
                      r_loops: 3,
                      r_rows: 1,
                      r_table_time_ms: 6,
                      r_other_time_ms: 0,
                    },
                  },
                ],
              },
            }),
          },
        ],
      ]
    )!;
    const heat = planHeat(plan);
    expect(heat.kind).toBe("time");
    // Nested Loop: 3 + 6 ms derived from its children.
    expect(planNumber(plan.nodes[0]!.data, "Actual Total Time")).toBe(9);
    expect(heat.hottestId).toBe(2);
  });
});

describe("DuckDB plans", () => {
  it("reads EXPLAIN (FORMAT JSON)", () => {
    const plan = duckdb("physical_plan", "duckdb15-explain.json");
    expect(plan.actual).toBe(false);
    expect(plan.nodes.map((node) => `${node.depth}:${node.type}`)).toEqual([
      "0:PROJECTION",
      "1:PERFECT HASH GROUP BY",
      "2:PROJECTION",
      "3:PROJECTION",
      "4:SEQ SCAN",
    ]);
    const scan = plan.nodes[4]!;
    expect(scan.label).toBe("SEQ SCAN on memory.main.t");
    expect(scan.data.Filter).toBe("a>10");
    expect(planNumber(scan.data, "Plan Rows")).toBe(200);
  });

  it("reads EXPLAIN (ANALYZE, FORMAT JSON) with inclusive times", () => {
    const plan = duckdb("analyzed_plan", "duckdb15-explain-analyze.json");
    expect(plan.actual).toBe(true);
    // The profiler's EXPLAIN_ANALYZE wrapper is not a plan node.
    expect(plan.nodes[0]!.type).toBe("PROJECTION");
    const scan = plan.nodes[plan.nodes.length - 1]!;
    expect(scan.type).toBe("SEQ SCAN");
    expect(planNumber(scan.data, "Actual Rows")).toBe(989);
    // A parent's time includes its children.
    const root = planNumber(plan.nodes[0]!.data, "Actual Total Time")!;
    const leaf = planNumber(scan.data, "Actual Total Time")!;
    expect(root).toBeGreaterThan(leaf);
    expect(planNumber(plan.document, "Execution Time")).toBeGreaterThan(0);
    expect(planHeat(plan).kind).toBe("time");
  });

  it("keeps the whole profile in the document for JSON and export", () => {
    const plan = duckdb("analyzed_plan", "duckdb15-explain-analyze.json");
    const json = JSON.stringify(plan.document);
    expect(json).toContain('"operator_name":"SEQ_SCAN"');
    expect(json).toContain('"operator_cardinality":989');
    expect(json).toContain("EXPLAIN_ANALYZE");
    // The derived execution time is readable but not serialized.
    expect(json).not.toContain("Execution Time");
    expect(JSON.parse(json)).toEqual(
      JSON.parse(fixture("duckdb15-explain-analyze.json"))
    );
    const estimated = duckdb("physical_plan", "duckdb15-explain.json");
    expect(estimated.document).toEqual({
      physical_plan: JSON.parse(fixture("duckdb15-explain.json")),
    });
  });

  it("ignores rows that are not a JSON plan", () => {
    expect(
      planFromResult(
        "duckdb",
        [{ name: "explain_key" }, { name: "explain_value" }],
        [
          [
            { t: "Str", v: "physical_plan" },
            { t: "Str", v: "┌──┐" },
          ],
        ]
      )?.actual ?? false
    ).toBe(false);
  });
});

describe("measuring hints", () => {
  it("name syntax the analyzer can read, without repeating the warning", () => {
    expect(oneCell("mysql", "mysql80-explain.json").analyzeHint).toBe(
      "EXPLAIN ANALYZE (MySQL 8.0.18 or later)"
    );
    expect(oneCell("mariadb", "mariadb11-explain.json").analyzeHint).toBe(
      "ANALYZE FORMAT=JSON"
    );
    expect(duckdb("physical_plan", "duckdb15-explain.json").analyzeHint).toBe(
      "EXPLAIN (ANALYZE, FORMAT JSON)"
    );
    for (const engine of ["mysql", "mariadb", "duckdb", "oracle"] as const) {
      const plan = planFromResult(engine, [{ name: "QUERY PLAN" }], [["a\nb"]]);
      expect(plan?.analyzeHint ?? "").not.toMatch(/executes/);
    }
    // SQL Server measured plans are not read: no hint.
    expect(
      planFromResult(
        "sqlserver",
        [{ name: "NodeId" }, { name: "Parent" }, { name: "PhysicalOp" }],
        [[1, 0, "Clustered Index Scan"]]
      )?.analyzeHint
    ).toBeUndefined();
  });
});

describe("SQL Server plans", () => {
  it("reads SHOWPLAN_ALL rows as a tree with readable labels", () => {
    const { columns, rows } = JSON.parse(
      fixture("sqlserver2022-showplan-all.json")
    ) as { columns: string[]; rows: unknown[][] };
    const plan = planFromResult(
      "sqlserver",
      columns.map((name) => ({ name })),
      rows
    )!;
    expect(plan.actual).toBe(false);
    expect(plan.nodes.map((node) => `${node.depth}:${node.type}`)).toEqual([
      "0:SELECT",
      "1:Sort",
      "2:Filter",
      "3:Clustered Index Seek",
    ]);
    expect(plan.nodes[1]!.label).toBe("Sort(ORDER BY:([o].[name] ASC))");
    expect(planNumber(plan.nodes[0]!.data, "Total Cost")).toBeCloseTo(
      0.0169,
      3
    );
    expect(planNumber(plan.nodes[0]!.data, "Plan Rows")).toBeCloseTo(113.3, 1);
  });
});
