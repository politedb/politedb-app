import { describe, expect, it } from "vitest";
import { diagramSchemaMetadataQueries } from "./diagram";

describe("diagramSchemaMetadataQueries", () => {
  it.each(["mysql", "mariadb"] as const)(
    "builds schema-wide metadata queries for %s",
    (engine) => {
      const queries = diagramSchemaMetadataQueries("fleet", engine);

      expect(queries?.foreignKeys).toContain("kcu.table_schema='fleet'");
      expect(queries?.foreignKeys).not.toContain("kcu.table_name=");
      expect(queries?.uniqueConstraints).toContain("non_unique=0");
      expect(queries?.uniqueConstraints).toContain("GROUP_CONCAT(column_name");
    }
  );

  it("builds schema-wide PostgreSQL metadata queries", () => {
    const queries = diagramSchemaMetadataQueries("public", "postgres");

    expect(queries?.foreignKeys).toContain("pg_catalog.pg_constraint");
    expect(queries?.foreignKeys).toContain("child_ns.nspname='public'");
    expect(queries?.foreignKeys).toContain("unnest(con.conkey)");
    expect(queries?.foreignKeys).toContain(
      "parent_key.ordinality=child_key.ordinality"
    );
    expect(queries?.foreignKeys).not.toContain(
      "information_schema.referential_constraints"
    );
    expect(queries?.uniqueConstraints).toContain("n.nspname='public'");
    expect(queries?.uniqueConstraints).toContain("i.indisunique");
  });

  it("keeps unsupported engines on the per-table fallback", () => {
    expect(diagramSchemaMetadataQueries("main", "sqlite")).toBeNull();
  });
});
