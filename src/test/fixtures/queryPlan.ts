// Synthetic PostgreSQL-shaped data for regression tests; not a live benchmark.
export const queryPlanFixture = [
  {
    "Planning Time": 0.42,
    "Execution Time": 2840,
    Plan: {
      "Node Type": "Sort",
      "Startup Cost": 42000,
      "Total Cost": 42100,
      "Plan Rows": 120,
      "Actual Rows": 120,
      "Actual Loops": 1,
      "Actual Total Time": 2839,
      "Shared Read Blocks": 18420,
      "Sort Space Type": "Disk",
      "Sort Method": "external merge",
      Plans: [
        {
          "Node Type": "Seq Scan",
          "Relation Name": "orders",
          Schema: "public",
          Filter: "(customer_id = 8421)",
          "Plan Rows": 2,
          "Total Cost": 40000,
          "Actual Rows": 120,
          "Actual Loops": 1,
          "Actual Total Time": 2780,
          "Rows Removed by Filter": 2399880,
          "Shared Read Blocks": 18420,
        },
      ],
    },
  },
];
