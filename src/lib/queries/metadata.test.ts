import { describe, expect, it } from "vitest";
import { getMetadataQueries } from "./metadata";

describe("PostgreSQL metadata queries", () => {
  const queries = getMetadataQueries("postgres");

  it("returns complete table size semantics and partition totals", () => {
    expect(queries.tablesQuery).toContain("WITH RECURSIVE visible_relations");
    expect(queries.tablesQuery).toContain("JOIN pg_inherits");
    expect(queries.tablesQuery).toContain("SUM(pg_table_size(tree.rel_oid))");
    expect(queries.tablesQuery).toContain(
      "SUM(pg_total_relation_size(tree.rel_oid))"
    );
    expect(queries.tablesQuery).not.toContain("pg_size_pretty");
    expect(queries.tablesQuery).not.toContain("pg_relation_size(c.oid)");
  });

  it("treats unknown estimates as null and includes supported relation kinds", () => {
    expect(queries.tablesQuery).toContain("relation.reltuples < 0");
    expect(queries.tablesQuery).toContain(
      "FILTER (WHERE relation.relkind <> 'p')"
    );
    expect(queries.tablesQuery).toContain("THEN NULL");
    expect(queries.tablesQuery).toContain("'r', 'p', 'v', 'm', 'f'");
    expect(queries.tablesQuery).toContain("c.relkind IN ('v', 'm')");
  });

  it("excludes PostgreSQL internal schemas from every catalog query", () => {
    for (const query of [
      queries.schemasQuery,
      queries.routinesQuery,
      queries.triggersQuery,
      queries.tablesQuery,
      queries.columnsQuery,
    ]) {
      expect(query).toContain("!~ '^pg_'");
    }
  });
});
