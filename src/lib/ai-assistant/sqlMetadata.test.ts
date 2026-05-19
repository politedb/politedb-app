import { describe, expect, it } from "vitest";
import type { TableItem } from "src/types";
import {
  formatSqlExecutionError,
  formatSqlValidationIssues,
  parseDatabaseExecutionError,
  validateSqlAgainstMetadata,
} from "./sqlMetadata";

const tables: TableItem[] = [
  { schema: "public", name: "activations" },
  { schema: "public", name: "licenses" },
];

const columnsByTable = {
  "public.activations": ["id", "license_id", "created_at"],
  "public.licenses": ["id", "max_connections", "name"],
};

describe("validateSqlAgainstMetadata", () => {
  it("blocks unknown columns before execution", () => {
    const validation = validateSqlAgainstMetadata({
      sql: "SELECT MAX(connections) AS max_connections FROM public.activations;",
      tables,
      columnsByTable,
      activeSchema: "public",
    });

    expect(validation.ok).toBe(false);
    expect(validation.issues[0]).toMatchObject({
      kind: "unknown_column",
      table: "public.activations",
      column: "connections",
    });
  });

  it("allows valid columns", () => {
    const validation = validateSqlAgainstMetadata({
      sql: "SELECT MAX(max_connections) FROM public.licenses;",
      tables,
      columnsByTable,
      activeSchema: "public",
    });

    expect(validation.ok).toBe(true);
  });
});

describe("formatSqlExecutionError", () => {
  it("formats postgres column errors in Vietnamese", () => {
    const parsed = parseDatabaseExecutionError(
      'ERROR: column "connections" does not exist'
    );
    expect(parsed?.kind).toBe("unknown_column");

    const text = formatSqlExecutionError({
      error: new Error('ERROR: column "connections" does not exist'),
      lang: { code: "vie", name: "Vietnamese" },
      sql: "SELECT MAX(connections) FROM public.activations;",
      tables,
      columnsByTable,
      activeSchema: "public",
    });

    expect(text).toContain('cột "connections"');
    expect(text).toContain("public.activations");
  });
});

describe("formatSqlValidationIssues", () => {
  it("lists available columns for unknown column issues", () => {
    const text = formatSqlValidationIssues(
      [
        {
          kind: "unknown_column",
          table: "public.activations",
          column: "connections",
          availableColumns: columnsByTable["public.activations"],
        },
      ],
      { code: "vie", name: "Vietnamese" }
    );

    expect(text).toContain("connections");
    expect(text).toContain("license_id");
  });
});
