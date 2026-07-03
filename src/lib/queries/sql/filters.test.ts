import { describe, expect, it } from "vitest";
import { buildWhereClause } from "./filters";

describe("buildWhereClause", () => {
  it("aligns MySQL string collation for Contains filters", () => {
    const where = buildWhereClause(
      [
        {
          id: 1,
          column: "name",
          operator: "Contains",
          value: "firefox",
          enabled: true,
        },
      ],
      "AND",
      "mysql"
    );

    expect(where).toBe(
      " WHERE CONVERT(`name` USING utf8mb4) COLLATE utf8mb4_unicode_ci LIKE CONVERT(UNHEX('2566697265666f7825') USING utf8mb4) COLLATE utf8mb4_unicode_ci"
    );
  });
});
