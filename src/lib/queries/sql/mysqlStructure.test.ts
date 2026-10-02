import { describe, expect, it } from "vitest";
import { tableConstraintsMySqlQuery } from "./mysqlStructure";

describe("tableConstraintsMySqlQuery", () => {
  it("emits string true/false for is_primary so FE parsing is stable", () => {
    const sql = tableConstraintsMySqlQuery("fleet", "users_deleted");
    expect(sql).toContain("table_schema='fleet'");
    expect(sql).toContain("table_name='users_deleted'");
    expect(sql).toContain("THEN 'true' ELSE 'false' END");
    expect(sql).not.toContain("THEN TRUE ELSE FALSE");
  });
});
