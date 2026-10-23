import { describe, expect, it } from "vitest";
import { queryPlanFixture } from "src/test/fixtures/queryPlan";
import {
  formatPlanNumber,
  parseQueryPlan,
  planHeat,
  planParents,
  planMetrics,
  planNumber,
} from "./plan";
import { planFromResult } from "./fromResult";
import { analyzeQueryPlan } from "./findings";
import { queryPlanReport } from "./report";

describe("PostgreSQL query plans", () => {
  it.each(["Json", "Str"])("decodes Tauri %s cells before parsing", (t) => {
    const value = JSON.stringify([
      {
        Plan: {
          "Node Type": "Seq Scan",
          "Relation Name": "Category",
          "Startup Cost": 0,
          "Total Cost": 1.07,
          "Plan Rows": 7,
          "Plan Width": 57,
        },
      },
    ]);
    const plan = planFromResult(
      "postgres",
      [{ name: "QUERY PLAN" }],
      [[{ t, v: value }]]
    );
    expect(plan?.nodes[0].label).toBe("Seq Scan on Category");
    expect(plan?.actual).toBe(false);
  });
  it.each([
    { t: "Null" },
    { t: "Json", v: "invalid" },
    { t: "Json" },
    { t: "Bool", v: true },
  ])("rejects invalid tagged cells without throwing", (cell) => {
    expect(
      planFromResult("postgres", [{ name: "QUERY PLAN" }], [[cell]])
    ).toBeNull();
  });
  it("accepts JSON strings and structured documents with stable preorder node IDs", () => {
    const plan = parseQueryPlan(JSON.stringify(queryPlanFixture))!;
    expect(plan).toEqual(parseQueryPlan(queryPlanFixture[0]));
    expect(plan.actual).toBe(true);
    expect(plan.nodes.map((n) => [n.id, n.depth, n.type])).toEqual([
      [0, 0, "Sort"],
      [1, 1, "Seq Scan"],
    ]);
  });
  it.each([
    null,
    "not JSON",
    [],
    [{}, {}],
    { Plan: {} },
    { Plan: { "Node Type": "Sort", Plans: [null] } },
  ])("rejects malformed data: %j", (value) => {
    expect(parseQueryPlan(value)).toBeNull();
  });
  it("rejects oversized and cyclic plans without throwing", () => {
    const root: Record<string, unknown> = { "Node Type": "Sort" };
    root.Plans = [root];
    expect(parseQueryPlan({ Plan: root })).toBeNull();
    expect(parseQueryPlan(" ".repeat(5 * 1024 * 1024 + 1))).toBeNull();
    expect(
      parseQueryPlan({
        Plan: {
          "Node Type": "Append",
          Plans: Array.from({ length: 5001 }, () => ({
            "Node Type": "Result",
          })),
        },
      })
    ).toBeNull();
  });
  it("only treats a single JSON plan cell as a Postgres plan", () => {
    expect(
      planFromResult(
        "postgres",
        [{ name: "QUERY PLAN" }],
        [[JSON.stringify(queryPlanFixture)]]
      )
    ).not.toBeNull();
    expect(
      planFromResult("postgres", [{ name: "payload" }], [[queryPlanFixture]])
    ).not.toBeNull();
    expect(
      planFromResult(
        "postgres",
        [{ name: "QUERY PLAN" }],
        [[queryPlanFixture], [queryPlanFixture]]
      )
    ).toBeNull();
    expect(
      planFromResult("postgres", [{ name: "QUERY PLAN" }], undefined)
    ).toBeNull();
  });
  it("rejects excessively nested metadata outside the plan tree", () => {
    let metadata: unknown = "leaf";
    for (let i = 0; i < 150; i++) metadata = { nested: metadata };
    expect(
      parseQueryPlan({ Plan: { "Node Type": "Result" }, metadata })
    ).toBeNull();
  });
  it("sizes the plan bar from actual time on measured plans, cost otherwise", () => {
    const measured = parseQueryPlan({
      Plan: {
        "Node Type": "Nested Loop",
        "Total Cost": 100,
        "Actual Total Time": 100,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "cheap_but_slow",
            "Total Cost": 10,
            "Actual Total Time": 90,
            "Actual Loops": 1,
          },
          {
            "Node Type": "Index Scan",
            "Relation Name": "costly_but_fast",
            "Total Cost": 90,
            "Actual Total Time": 10,
            "Actual Loops": 1,
          },
        ],
      },
    })!;
    // Root spends 100 ms; its children 90 + 10 inclusive.
    const heat = planHeat(measured);
    expect(heat.kind).toBe("time");
    expect(heat.nodes[2]!.inclusiveShare).toBe(0.1);
    expect(heat.nodes[1]!.selfShare).toBe(0.9);
    expect(heat.hottestId).toBe(1);
    const estimated = parseQueryPlan({
      Plan: {
        "Node Type": "Nested Loop",
        "Total Cost": 100,
        Plans: [
          {
            "Node Type": "Index Scan",
            "Total Cost": 90,
          },
        ],
      },
    })!;
    const costHeat = planHeat(estimated);
    expect(costHeat.kind).toBe("cost");
    expect(costHeat.nodes[1]!.inclusiveShare).toBe(0.9);
    expect(costHeat.nodes[0]!.self).toBe(10);
    expect(costHeat.hottestId).toBe(1);
  });
  it("multiplies per-loop time by loops to find the real hot spot", () => {
    const plan = parseQueryPlan({
      Plan: {
        "Node Type": "Nested Loop",
        "Actual Total Time": 1000,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Relation Name": "outer_rows",
            "Actual Total Time": 50,
            "Actual Loops": 1,
          },
          {
            "Node Type": "Index Scan",
            "Relation Name": "inner_rows",
            // 0.09 ms per loop, but 10,000 loops = 900 ms.
            "Actual Total Time": 0.09,
            "Actual Loops": 10000,
          },
        ],
      },
    })!;
    const heat = planHeat(plan);
    expect(heat.nodes[2]!.inclusive).toBeCloseTo(900);
    expect(heat.hottestId).toBe(2);
    expect(heat.nodes[0]!.self).toBeCloseTo(50);
  });
  it("clamps overlapping parallel worker time", () => {
    const plan = parseQueryPlan({
      Plan: {
        "Node Type": "Gather",
        "Actual Total Time": 100,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Parallel Seq Scan",
            "Actual Total Time": 95,
            "Actual Loops": 3,
          },
        ],
      },
    })!;
    const heat = planHeat(plan);
    expect(heat.nodes[0]!.self).toBe(0);
    expect(heat.nodes[1]!.inclusiveShare).toBe(1);
  });
  it("counts a CTE producer inside the CTE Scan that runs it", () => {
    // Join 100 ms: InitPlan CTE producer 80 ms (displayed under the join),
    // CTE Scan 81 ms (includes the producer), other input 5 ms.
    const plan = parseQueryPlan({
      Plan: {
        "Node Type": "Hash Join",
        "Actual Total Time": 100,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "InitPlan",
            "Subplan Name": "CTE recent",
            "Relation Name": "orders",
            "Actual Total Time": 80,
            "Actual Loops": 1,
          },
          {
            "Node Type": "CTE Scan",
            "CTE Name": "recent",
            "Actual Total Time": 81,
            "Actual Loops": 1,
          },
          {
            "Node Type": "Seq Scan",
            "Relation Name": "customers",
            "Actual Total Time": 5,
            "Actual Loops": 1,
          },
        ],
      },
    })!;
    const heat = planHeat(plan);
    expect(heat.nodes[2]!.self).toBeCloseTo(1); // CTE Scan alone
    expect(heat.nodes[0]!.self).toBeCloseTo(14); // join: 100 - 81 - 5
    expect(heat.hottestId).toBe(1); // the producer, 80 ms
  });

  it("does not guess when several nodes read the same CTE", () => {
    const plan = parseQueryPlan({
      Plan: {
        "Node Type": "Append",
        "Actual Total Time": 100,
        "Actual Loops": 1,
        Plans: [
          {
            "Node Type": "Seq Scan",
            "Parent Relationship": "InitPlan",
            "Subplan Name": "CTE x",
            "Actual Total Time": 70,
            "Actual Loops": 1,
          },
          {
            "Node Type": "CTE Scan",
            "CTE Name": "x",
            "Actual Total Time": 60,
            "Actual Loops": 1,
          },
          {
            "Node Type": "CTE Scan",
            "CTE Name": "x",
            "Actual Total Time": 30,
            "Actual Loops": 1,
          },
        ],
      },
    })!;
    const heat = planHeat(plan);
    expect(heat.nodes[2]!.attribution).toBe("shared");
    expect(heat.nodes[2]!.self).toBeUndefined();
    expect(heat.nodes[0]!.self).toBeCloseTo(10); // 100 - 60 - 30
    expect(heat.hottestId).toBe(1);
  });

  it("derives parents from pre-order depths", () => {
    const plan = parseQueryPlan({
      Plan: {
        "Node Type": "Hash Join",
        Plans: [
          { "Node Type": "Seq Scan" },
          { "Node Type": "Hash", Plans: [{ "Node Type": "Seq Scan" }] },
        ],
      },
    })!;
    expect(planParents(plan)).toEqual([null, 0, 0, 2]);
  });
  it("does not invent execution metrics for estimated plans", () => {
    const plan = parseQueryPlan([
      { Plan: { "Node Type": "Result", "Total Cost": 1 } },
    ])!;
    expect(plan.actual).toBe(false);
    expect(planMetrics(plan)[0][1]).toBeUndefined();
    expect(formatPlanNumber(undefined)).toBe("Not available");
    expect(formatPlanNumber(0, " ms")).toBe("0 ms");
  });
  it("keeps zero values but rejects nonfinite, negative and string metrics", () => {
    for (const value of [-1, NaN, Infinity, "100"])
      expect(planNumber({ n: value }, "n")).toBeUndefined();
    expect(planNumber({ n: 0 }, "n")).toBe(0);
  });
  it("does not sum inclusive buffer counts", () => {
    const read = planMetrics(parseQueryPlan(queryPlanFixture)!).find(
      ([label]) => label === "Shared blocks read"
    );
    expect(read?.[1]).toBe(18420);
  });
  it("reports selective scans, spills and estimate mismatch", () => {
    const findings = analyzeQueryPlan(parseQueryPlan(queryPlanFixture)!);
    // Most severe first, plan order within a severity.
    expect(findings.map((f) => [f.severity, f.title])).toEqual([
      ["high", "Selective filter after sequential scan"],
      ["medium", "Sort spilled to disk"],
      ["medium", "Row estimate differs by at least 10x"],
    ]);
  });
  it("avoids estimate findings beneath LIMIT and parallel gathers", () => {
    for (const type of ["Limit", "Gather", "Gather Merge"]) {
      const document = structuredClone(queryPlanFixture[0]);
      document.Plan["Node Type"] = type;
      expect(
        analyzeQueryPlan(parseQueryPlan(document)!).some((f) =>
          f.title.includes("estimate differs")
        )
      ).toBe(false);
    }
  });
  it("ignores unexecuted nodes and unfiltered sequential scans", () => {
    const node = {
      "Node Type": "Seq Scan",
      "Actual Loops": 0,
      Filter: "x = 1",
      "Rows Removed by Filter": 9000,
      "Actual Rows": 1,
    };
    expect(analyzeQueryPlan(parseQueryPlan({ Plan: node })!)).toEqual([]);
    expect(
      analyzeQueryPlan(parseQueryPlan({ Plan: { "Node Type": "Seq Scan" } })!)
    ).toEqual([]);
  });
  it("keeps per-loop actual rows comparable to per-loop estimated rows", () => {
    const plan = parseQueryPlan({
      Plan: {
        "Node Type": "Index Scan",
        "Plan Rows": 100,
        "Actual Rows": 100,
        "Actual Loops": 1000,
      },
    })!;
    expect(analyzeQueryPlan(plan)).toEqual([]);
  });
  it("exports real plan data with interpretation and privacy caveats", () => {
    const report = queryPlanReport(parseQueryPlan(queryPlanFixture)!);
    expect(report).toContain("2,840 ms");
    expect(report).toContain("Parent metrics include children");
    expect(report).toContain("literal values");
    expect(report).toContain('"Relation Name": "orders"');
  });
});
