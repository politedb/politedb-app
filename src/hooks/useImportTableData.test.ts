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

  it("validates beyond preview rows when full validation is enabled", () => {
    const rows = Array.from({ length: 101 }, (_, index) => [
      index === 100 ? "bad" : String(index),
    ]);

    expect(
      validateImportPreview(
        { headers: ["id"], rows },
        [{ name: "id", db_type: "int" }],
        {
          firstIsHeaders: true,
          nullMode: "empty-string",
          columnMapping: { id: 0 },
        }
      )
    ).toHaveLength(0);

    expect(
      validateImportPreview(
        { headers: ["id"], rows },
        [{ name: "id", db_type: "int" }],
        {
          firstIsHeaders: true,
          nullMode: "empty-string",
          fullValidation: true,
          columnMapping: { id: 0 },
        }
      )
    ).toMatchObject([{ row: 101, column: "id", value: "bad" }]);
  });
});

describe("import column helpers", () => {
  it("maps headers ignoring case and spaces, exact names first", async () => {
    const { buildDefaultImportMapping } = await import("./useImportTableData");
    const mapping = buildDefaultImportMapping(
      { headers: [" Email ", "NAME", "name"], rows: [] },
      [
        { name: "email", db_type: "text" },
        { name: "name", db_type: "text" },
        { name: "age", db_type: "int" },
      ],
      true
    );
    expect(mapping).toEqual({ email: 0, name: 2, age: null });
  });

  it("lists columns that need a value: NOT NULL, no default, not generated", async () => {
    const { requiredImportColumns } = await import("./useImportTableData");
    const structure = (
      name: string,
      extra: Partial<import("src/types").TableStructure> = {}
    ) => ({
      column_name: name,
      data_type: "text",
      is_nullable: "NO",
      check: "",
      column_default: "",
      foreign_key: "",
      comment: "",
      ...extra,
    });
    const columns = ["id", "email", "note", "created", "code", "uuid"].map(
      (name) => ({ name, db_type: "text" })
    );
    expect(
      requiredImportColumns(columns, [
        structure("id", { is_identity: true }),
        structure("email"),
        structure("note", { is_nullable: "YES" }),
        structure("created", { column_default: "now()" }),
        structure("code", { default_is_null: false, column_default: "" }),
        structure("uuid", { extra: "auto_increment" }),
      ])
    ).toEqual(["email"]);
    expect(requiredImportColumns(columns, null)).toEqual([]);
  });
});
