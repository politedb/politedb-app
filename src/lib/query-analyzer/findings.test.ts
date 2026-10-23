import { describe, expect, it } from "vitest";
import { analyzeQueryPlan, indexSuggestion } from "./findings";
import { parseQueryPlan, type PlanRecord } from "./plan";

function findings(plan: PlanRecord, extra: PlanRecord = {}) {
  return analyzeQueryPlan(parseQueryPlan({ Plan: plan, ...extra })!);
}

function titles(plan: PlanRecord, extra?: PlanRecord) {
  return findings(plan, extra).map((f) => f.title);
}

const scan = (fields: PlanRecord = {}): PlanRecord => ({
  "Node Type": "Seq Scan",
  "Actual Rows": 10,
  "Actual Loops": 1,
  ...fields,
});

describe("analyzeQueryPlan rules", () => {
  it("flags a nested loop whose inner side runs many times", () => {
    const plan = {
      "Node Type": "Nested Loop",
      "Actual Rows": 5000,
      "Actual Loops": 1,
      Plans: [
        scan({ "Actual Rows": 5000 }),
        {
          "Node Type": "Index Scan",
          "Actual Rows": 1,
          "Actual Loops": 5000,
        },
      ],
    };
    const [finding] = findings(plan);
    expect(finding).toMatchObject({
      nodeId: 0,
      severity: "high",
      title: "Nested loop repeats its inner side many times",
    });
    expect(finding!.detail).toContain("5,000 times");

    plan.Plans[1]!["Actual Loops"] = 999;
    expect(titles(plan)).toEqual([]);
  });

  it("flags a subplan run once per row", () => {
    const plan = {
      "Node Type": "Seq Scan",
      "Actual Rows": 2000,
      "Actual Loops": 1,
      Plans: [
        {
          "Node Type": "Aggregate",
          "Parent Relationship": "SubPlan",
          "Actual Rows": 1,
          "Actual Loops": 2000,
        },
      ],
    };
    expect(findings(plan)[0]).toMatchObject({
      nodeId: 1,
      severity: "high",
      title: "Subquery runs once per row",
    });
  });

  it("flags heap fetches on an index-only scan", () => {
    const plan = {
      "Node Type": "Index Only Scan",
      "Actual Rows": 5000,
      "Actual Loops": 1,
      "Heap Fetches": 4000,
    };
    expect(titles(plan)).toEqual(["Index-only scan still reads the table"]);
    expect(titles({ ...plan, "Heap Fetches": 100 })).toEqual([]);
    // 4,000 of 1,000,000 rows is a small share.
    expect(titles({ ...plan, "Actual Rows": 1_000_000 })).toEqual([]);
  });

  it("flags a lossy bitmap heap scan only", () => {
    const [finding] = findings({
      "Node Type": "Bitmap Heap Scan",
      "Actual Loops": 3,
      "Lossy Heap Blocks": 12,
      "Rows Removed by Index Recheck": 500,
    });
    expect(finding?.title).toBe("Bitmap scan became lossy");
    // Recheck removals are per loop.
    expect(finding?.detail).toContain("1,500 rows removed");
    expect(finding?.detail).toContain("BRIN");
    // Exact bitmaps and non-bitmap rechecks (e.g. GiST) are not lossy.
    expect(
      titles({ "Node Type": "Bitmap Heap Scan", "Exact Heap Blocks": 12 })
    ).toEqual([]);
    expect(
      titles({
        "Node Type": "Index Scan",
        "Rows Removed by Index Recheck": 5000,
      })
    ).toEqual([]);
  });

  it("flags fewer parallel workers than planned", () => {
    expect(
      titles({
        "Node Type": "Gather",
        "Workers Planned": 4,
        "Workers Launched": 1,
      })
    ).toEqual(["Fewer parallel workers than planned"]);
    expect(
      titles({
        "Node Type": "Gather",
        "Workers Planned": 2,
        "Workers Launched": 2,
      })
    ).toEqual([]);
    // Estimated plans have no launched count.
    expect(titles({ "Node Type": "Gather", "Workers Planned": 2 })).toEqual([]);
  });

  it("flags temporary files on the node that wrote them", () => {
    expect(
      titles({ "Node Type": "Hash Join", "Temp Written Blocks": 300 })
    ).toEqual(["Writes temporary files"]);
    expect(
      titles({
        "Node Type": "Sort",
        "Sort Space Type": "Disk",
        "Temp Written Blocks": 300,
      })
    ).toEqual(["Sort spilled to disk"]);
    // The counter includes children: an aggregate over a spilling sort.
    expect(
      findings({
        "Node Type": "Aggregate",
        "Temp Written Blocks": 300,
        Plans: [
          {
            "Node Type": "Sort",
            "Sort Space Type": "Disk",
            "Temp Written Blocks": 300,
          },
        ],
      }).map((f) => [f.nodeId, f.title])
    ).toEqual([[1, "Sort spilled to disk"]]);
  });

  it("flags JIT that dominates execution, on the root", () => {
    const plan = scan();
    const jit = (total: number, execution: number) => ({
      JIT: { Functions: 12, Timing: { Total: total } },
      "Execution Time": execution,
    });
    expect(findings(plan, jit(450, 900))[0]).toMatchObject({
      nodeId: 0,
      severity: "high",
      title: "JIT compilation takes a large share of the time",
    });
    expect(titles(plan, jit(50, 100))).toEqual([]);
    expect(titles(plan, jit(150, 60_000))).toEqual([]);
    // Parallel JIT time is summed across workers: not a share of wall time.
    const parallel = {
      "Node Type": "Gather",
      "Workers Planned": 2,
      "Workers Launched": 2,
      Plans: [scan()],
    };
    expect(titles(parallel, jit(800, 500))).toEqual([]);
  });

  it("finds the labelled inner side of a nested loop", () => {
    const loop = (children: PlanRecord[]) =>
      titles({
        "Node Type": "Nested Loop",
        "Actual Rows": 10,
        "Actual Loops": 1,
        Plans: children,
      });
    const child = (relationship: string, loops: number) => ({
      "Node Type": "Index Scan",
      "Parent Relationship": relationship,
      "Actual Rows": 1,
      "Actual Loops": loops,
    });
    // An InitPlan comes first; the inner side is third.
    expect(
      loop([child("InitPlan", 1), child("Outer", 1), child("Inner", 5000)])
    ).toEqual(["Nested loop repeats its inner side many times"]);
    // A repeated InitPlan/SubPlan is not the inner side.
    expect(
      loop([child("Outer", 1), child("Inner", 1), child("InitPlan", 5000)])
    ).toEqual([]);
  });

  it("orders findings by severity, then plan order", () => {
    const plan = {
      "Node Type": "Sort",
      "Sort Space Type": "Disk",
      "Actual Rows": 10,
      "Actual Loops": 1,
      Plans: [
        scan({
          "Relation Name": "orders",
          Filter: "(status = 'x'::text)",
          "Rows Removed by Filter": 90_000,
        }),
      ],
    };
    expect(findings(plan).map((f) => [f.nodeId, f.severity])).toEqual([
      [1, "high"],
      [0, "medium"],
    ]);
  });
});

describe("indexSuggestion", () => {
  const node = (data: PlanRecord) =>
    parseQueryPlan({ Plan: { "Node Type": "Seq Scan", ...data } })!.nodes[0]!;
  const suggest = (filter: string, extra: PlanRecord = {}) =>
    indexSuggestion(
      node({ "Relation Name": "orders", Alias: "o", Filter: filter, ...extra })
    );

  it("builds an index from the compared columns, without literals", () => {
    const sql = suggest(
      "((status = 'shipped secret'::text) AND (o.customer_id = 42) AND (created_at >= now()))",
      { Schema: "sales" }
    );
    expect(sql).toBe(
      'CREATE INDEX CONCURRENTLY ON "sales"."orders" (status, customer_id, created_at);'
    );
    expect(sql).not.toContain("secret");
  });

  it("never reads columns out of string literals", () => {
    expect(suggest("(note = '(secret_customer = 123)'::text)")).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (note);'
    );
    expect(suggest("(note = 'it''s (\"Secret Name\" = 1)'::text)")).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (note);'
    );
    expect(suggest("(note = 'unterminated")).toBeUndefined();
  });

  it("quotes relation and schema names safely", () => {
    for (const [name, quoted] of [
      ['Order"Items', '"Order""Items"'],
      ["select", '"select"'],
      ['"Odd Table', '"""Odd Table"'],
    ]) {
      expect(suggest("(a = 1)", { "Relation Name": name, Alias: name })).toBe(
        `CREATE INDEX CONCURRENTLY ON ${quoted} (a);`
      );
    }
  });

  it("keeps quoted column identifiers as PostgreSQL printed them", () => {
    expect(suggest('(("Unit Price" > 10) AND (o."select" = 1))')).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" ("Unit Price", "select");'
    );
  });

  it("refuses filters it cannot index as one conjunction", () => {
    // Another relation's column (correlated filter).
    expect(
      suggest("((o.id = 1) AND (outer_customer.secret_id = 2))")
    ).toBeUndefined();
    // OR / NOT / CASE.
    expect(suggest("((a = 1) OR (b = 2))")).toBeUndefined();
    expect(suggest("((a = 1) AND (NOT archived))")).toBeUndefined();
    expect(
      suggest("(CASE WHEN (a = 1) THEN true ELSE false END)")
    ).toBeUndefined();
    // Comparisons inside function arguments are not searchable predicates.
    expect(suggest("(lower(name) ~~ 'a%'::text)")).toBeUndefined();
    expect(suggest("(coalesce((a = 1), false))")).toBeUndefined();
    // No relation.
    expect(indexSuggestion(node({ Filter: "(a = 1)" }))).toBeUndefined();
  });

  it("accepts only a conjunction of comparisons on columns", () => {
    // Function, COALESCE or boolean wrappers without an extra pair of parens.
    expect(suggest("COALESCE((a = 1), false)")).toBeUndefined();
    expect(suggest("bool_identity((a = 1))")).toBeUndefined();
    // Boolean expressions compared with each other are not a conjunction.
    expect(suggest("((a = 1) = (b = 2))")).toBeUndefined();
    // A cast or expression around the column.
    expect(suggest("((status)::text = 'x'::text)")).toBeUndefined();
    // The whole filter is checked, not just the first three columns.
    expect(
      suggest(
        "((a = 1) AND (b = 2) AND (c = 3) AND (outer_customer.secret_id = 4))"
      )
    ).toBeUndefined();
    // Four valid columns: the first three are used.
    expect(suggest("((a = 1) AND (b = 2) AND (c = 3) AND (d = 4))")).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (a, b, c);'
    );
    // The right-hand side can be any expression.
    expect(
      suggest("((a = ANY ('{1,2}'::integer[])) AND (b > lower('X'::text)))")
    ).toBe('CREATE INDEX CONCURRENTLY ON "orders" (a, b);');
  });

  it("suggests a default index only for B-tree comparisons", () => {
    for (const filter of [
      "(tags <@ '{1,2}'::integer[])",
      "(tags @> '{1}'::integer[])",
      "(address << '10.0.0.0/8'::inet)",
      "(address <<= '10.0.0.0/8'::inet)",
      "(address >> '10.0.0.1'::inet)",
      "(payload <@ '{}'::jsonb)",
      "(name ~~ 'abc%'::text)",
      "(name !~~ '%abc%'::text)",
      "(name ~ '^a'::text)",
      "(a IS DISTINCT FROM 1)",
      "(a IS NOT DISTINCT FROM 1)",
      "(flag IS TRUE)",
    ]) {
      expect(suggest(filter)).toBeUndefined();
    }
    for (const op of ["=", "<", ">", "<=", ">=", "<>", "!="]) {
      expect(suggest(`(a ${op} 1)`)).toBe(
        'CREATE INDEX CONCURRENTLY ON "orders" (a);'
      );
    }
    // Operators split by a space are not one operator.
    expect(suggest("(a < -1)")).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (a);'
    );
  });

  it("refuses comparisons with an explicit collation", () => {
    expect(suggest(`(name > ('m'::text COLLATE "C"))`)).toBeUndefined();
    expect(suggest(`(name = ('m'::text COLLATE "C"))`)).toBeUndefined();
    expect(
      suggest(`((id = 1) AND (name < ('m'::text COLLATE "C")))`)
    ).toBeUndefined();
    // Ordinary text comparisons, and the word inside a literal or quoted
    // identifier, are fine.
    expect(suggest("(name = 'x'::text)")).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (name);'
    );
    expect(suggest("(name = 'a COLLATE b'::text)")).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (name);'
    );
    expect(suggest('(name = o."collate")')).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (name);'
    );
  });

  it("never treats value keywords as columns", () => {
    expect(suggest("(CURRENT_USER = owner)")).toBeUndefined();
    expect(suggest("(CURRENT_DATE > created_at)")).toBeUndefined();
    expect(suggest("((a = 1) AND (true = flag))")).toBeUndefined();
    // A quoted identifier with that name is a real column.
    expect(suggest('("current_user" = 1)')).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" ("current_user");'
    );
  });

  it("supports IS NULL and IS NOT NULL", () => {
    expect(suggest("(deleted_at IS NULL)")).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (deleted_at);'
    );
    expect(suggest("((id = 1) AND (deleted_at IS NOT NULL))")).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (id, deleted_at);'
    );
  });

  it("is attached to a measured selective scan", () => {
    const [finding] = findings(
      scan({
        "Relation Name": "orders",
        Filter: "(status = 'x'::text)",
        "Rows Removed by Filter": 90_000,
      })
    );
    expect(finding?.sql).toBe(
      'CREATE INDEX CONCURRENTLY ON "orders" (status);'
    );
  });
});
