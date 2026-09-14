import { describe, expect, it } from "vitest";
import { queryPlanFixture } from "src/test/fixtures/queryPlan";
import {
  formatPlanNumber,
  parseQueryPlan,
  planFromResult,
  planMetrics,
  planNumber,
} from "./plan";
import { analyzeQueryPlan } from "./findings";
import { queryPlanReport } from "./report";

describe("PostgreSQL query plans", () => {
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
  it("only treats a single QUERY PLAN cell as a plan", () => {
    expect(
      planFromResult(
        [{ name: "QUERY PLAN" }],
        [JSON.stringify(queryPlanFixture)],
        1
      )
    ).not.toBeNull();
    expect(
      planFromResult([{ name: "payload" }], [queryPlanFixture], 1)
    ).toBeNull();
    expect(
      planFromResult([{ name: "QUERY PLAN" }], [queryPlanFixture], 2)
    ).toBeNull();
    expect(planFromResult([{ name: "QUERY PLAN" }], undefined, 1)).toBeNull();
  });
  it("rejects excessively nested metadata outside the plan tree", () => {
    let metadata: unknown = "leaf";
    for (let i = 0; i < 150; i++) metadata = { nested: metadata };
    expect(
      parseQueryPlan({ Plan: { "Node Type": "Result" }, metadata })
    ).toBeNull();
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
    expect(planMetrics(parseQueryPlan(queryPlanFixture)!)[4][1]).toBe(18420);
  });
  it("reports selective scans, spills and estimate mismatch", () => {
    const findings = analyzeQueryPlan(parseQueryPlan(queryPlanFixture)!);
    expect(findings.map((f) => f.title)).toEqual([
      "Sort spilled to disk",
      "Selective filter after sequential scan",
      "Row estimate differs by at least 10x",
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
