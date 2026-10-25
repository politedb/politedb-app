import { describe, expect, it } from "vitest";
import { createTableQuery } from "./ddl";

describe("createTableQuery nullable columns", () => {
  it("writes NOT NULL for a column the editor marks NO", () => {
    const sql = createTableQuery(
      "public",
      "people",
      [
        {
          column_name: "id",
          data_type: "int",
          is_nullable: "NO",
          column_default: "",
        },
        {
          column_name: "nick",
          data_type: "text",
          is_nullable: "YES",
          column_default: "",
        },
      ],
      ["id"],
      "postgres"
    );
    expect(sql).toContain('"id" int NOT NULL');
    expect(sql).not.toContain('"nick" text NOT NULL');
  });
});
