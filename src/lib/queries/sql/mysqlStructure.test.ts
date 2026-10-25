import { describe, expect, it } from "vitest";
import { tableConstraintsMySqlQuery } from "./mysqlStructure";

describe("tableConstraintsMySqlQuery", () => {
  it("stays executable once joined into one line", () => {
    const sql = tableConstraintsMySqlQuery("shop", "items");
    expect(sql).not.toContain("\n");
    // Nothing commented out: FROM, WHERE and GROUP BY are live.
    expect(sql).not.toMatch(/--|#/);
    expect(sql).toMatch(
      /SELECT .* FROM information_schema\.statistics WHERE .* GROUP BY /
    );
    expect(sql).toContain("has_prefix");
  });
});
