import { describe, expect, it } from "vitest";
import { tableForeignKeysQuery } from "./tableStructure";

describe("tableForeignKeysQuery", () => {
  it.each(["mysql", "mariadb"] as const)(
    "builds a compatible foreign-key query for %s",
    (engine) => {
      const query = tableForeignKeysQuery("fleet", "sessions", engine);

      expect(query).toContain("information_schema.key_column_usage");
      expect(query).toContain("GROUP_CONCAT(kcu.column_name");
      expect(query).toContain("kcu.table_schema='fleet'");
      expect(query).toContain("kcu.table_name='sessions'");
      expect(query).not.toContain("string_agg(");
    }
  );

  it("keeps the Postgres foreign-key aggregation", () => {
    const query = tableForeignKeysQuery("public", "sessions", "postgres");

    expect(query).toContain("string_agg(column_name");
    expect(query).not.toContain("GROUP_CONCAT(");
  });
});
