import { describe, expect, it } from "vitest";
import { comparePlans, heatLevel, nodeDetailGroups } from "./details";
import { parseQueryPlan, planHeat, planMetrics } from "./plan";

const plan = parseQueryPlan({
  Plan: {
    "Node Type": "Hash Join",
    "Total Cost": 100,
    "Plan Rows": 10,
    "Actual Rows": 500,
    "Actual Loops": 1,
    "Actual Total Time": 20,
    "Hash Cond": "(a.id = b.a_id)",
    "Join Type": "Inner",
    "Parallel Aware": false,
    "Async Capable": false,
    "Inner Unique": true,
    "Shared Hit Blocks": 12,
    Output: [],
    Plans: [
      { "Node Type": "Seq Scan", "Actual Total Time": 5, "Actual Loops": 1 },
    ],
  },
})!;

describe("nodeDetailGroups", () => {
  const groups = nodeDetailGroups(
    plan.nodes[0]!,
    planHeat(plan).nodes[0]!,
    "time"
  );
  const field = (group: string, label: string) =>
    groups.find((g) => g.id === group)?.fields.find((f) => f.label === label)
      ?.value;

  it("groups time, rows, conditions and I/O", () => {
    expect(groups.map((g) => g.id)).toEqual([
      "time",
      "rows",
      "conditions",
      "io",
      "other",
    ]);
    expect(field("time", "Own share")).toBe("75%");
    expect(field("time", "Time, all loops")).toBe("20 ms");
    expect(field("conditions", "Hash Cond")).toBe("(a.id = b.a_id)");
    expect(field("io", "Shared Hit Blocks")).toBe("12");
  });

  it("flags estimate errors and hides false flags and empty values", () => {
    expect(field("rows", "Estimate off by")).toBe("50x (underestimated)");
    const other = groups
      .find((g) => g.id === "other")!
      .fields.map((f) => f.label);
    expect(other).toEqual(["Inner Unique"]);
  });
});

describe("comparePlans", () => {
  it("lines up plan figures with the relative change", () => {
    const before = parseQueryPlan({
      Plan: { "Node Type": "Seq Scan", "Total Cost": 200 },
    })!;
    const after = parseQueryPlan({
      Plan: { "Node Type": "Index Scan", "Total Cost": 50 },
    })!;
    const rows = comparePlans(after, before, planMetrics);
    expect(rows).toEqual([
      {
        label: "Estimated total cost",
        unit: "",
        baseline: 200,
        current: 50,
        change: -0.75,
      },
    ]);
  });
});

describe("heatLevel", () => {
  it("maps own share to a colour level", () => {
    expect(heatLevel(0.6)).toBe("high");
    expect(heatLevel(0.3)).toBe("medium");
    expect(heatLevel(0.06)).toBe("low");
    expect(heatLevel(0.01)).toBe("none");
  });
});
