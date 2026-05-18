import { describe, expect, it } from "vitest";
import {
  buildDefaultImportMapping,
  validateImportPreview,
} from "./useImportTableData";

describe("CSV import helpers", () => {
  it("maps CSV headers to table columns", () => {
    const mapping = buildDefaultImportMapping(
      { headers: ["id", "name"], rows: [["1", "Ada"]] },
      [
        { name: "id", db_type: "int" },
        { name: "name", db_type: "text" },
        { name: "missing", db_type: "text" },
      ],
      true
    );

    expect(mapping).toEqual({ id: 0, name: 1, missing: null });
  });

  it("reports type preview issues", () => {
    const issues = validateImportPreview(
      { headers: ["id", "enabled", "payload"], rows: [["abc", "maybe", "{"]] },
      [
        { name: "id", db_type: "int" },
        { name: "enabled", db_type: "boolean" },
        { name: "payload", db_type: "json" },
      ],
      {
        firstIsHeaders: true,
        nullMode: "empty-string",
        columnMapping: { id: 0, enabled: 1, payload: 2 },
      }
    );

    expect(issues.map((issue) => issue.message)).toEqual([
      "Invalid number",
      "Invalid boolean",
      "Invalid JSON",
    ]);
  });

  it("allows empty values when configured as null", () => {
    const issues = validateImportPreview(
      { headers: ["id"], rows: [[""]] },
      [{ name: "id", db_type: "int" }],
      {
        firstIsHeaders: true,
        nullMode: "empty-as-null",
        columnMapping: { id: 0 },
      }
    );

    expect(issues).toHaveLength(0);
  });
});
