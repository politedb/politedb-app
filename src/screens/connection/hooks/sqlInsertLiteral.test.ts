import { describe, expect, it } from "vitest";
import {
  formatSqlInsertValue,
  jsonArrayToPgArraySql,
  pgArrayCastType,
  formatSqlInsertChunk,
} from "./sqlInsertLiteral";

function qIdent(name: string, _engine: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

describe("jsonArrayToPgArraySql", () => {
  it("converts JSON string array to ARRAY[]::text[]", () => {
    expect(jsonArrayToPgArraySql('["*"]', "_text")).toBe(
      "ARRAY['*']::text[]"
    );
    expect(
      jsonArrayToPgArraySql('["view_category","edit_post"]', "text[]")
    ).toBe("ARRAY['view_category', 'edit_post']::text[]");
  });

  it("handles nulls, bools, numbers, and quotes", () => {
    expect(jsonArrayToPgArraySql('[null, true, 2, "a\'b"]', "_text")).toBe(
      "ARRAY[NULL, TRUE, 2, 'a''b']::text[]"
    );
  });
});

describe("pgArrayCastType", () => {
  it("maps _text and text[]", () => {
    expect(pgArrayCastType("_text")).toBe("text[]");
    expect(pgArrayCastType("text[]")).toBe("text[]");
    expect(pgArrayCastType("_int4")).toBe("int4[]");
  });
});

describe("formatSqlInsertValue", () => {
  it("emits PG array SQL for Json cells on array columns", () => {
    expect(
      formatSqlInsertValue(
        { t: "Json", v: '["*"]' },
        { dbType: "_text", engine: "postgres" }
      )
    ).toBe("ARRAY['*']::text[]");
  });

  it("keeps JSON quoted for jsonb columns", () => {
    expect(
      formatSqlInsertValue(
        { t: "Json", v: '["*"]' },
        { dbType: "jsonb", engine: "postgres" }
      )
    ).toBe("'[\"*\"]'::jsonb");
  });

  it("does not double-escape backslashes in postgres JSON", () => {
    const raw =
      '{"type":"multi-choice","content":"<p>line\\n<img alt=\\"x\\">"}';
    const sql = formatSqlInsertValue(
      { t: "Json", v: raw },
      { dbType: "json", engine: "postgres" }
    );
    expect(sql).toBe(`'${raw}'::json`);
    expect(sql).not.toContain("\\\\n");
    expect(sql).not.toContain('\\\\"');
  });

  it("still escapes backslashes for mysql string literals", () => {
    expect(
      formatSqlInsertValue(
        { t: "Str", v: "a\\b" },
        { dbType: "text", engine: "mysql" }
      )
    ).toBe("'a\\\\b'");
  });

  it("quotes plain strings and leaves numbers unquoted", () => {
    expect(
      formatSqlInsertValue({ t: "Str", v: "hello" }, { engine: "postgres" })
    ).toBe("'hello'");
    expect(
      formatSqlInsertValue({ t: "I64", v: 42 }, { engine: "postgres" })
    ).toBe("42");
    expect(formatSqlInsertValue({ t: "Null" }, { engine: "postgres" })).toBe(
      "NULL"
    );
  });
});

describe("formatSqlInsertChunk", () => {
  it("formats permission_groups-style row with text[] permissions", () => {
    const sql = formatSqlInsertChunk({
      engine: "postgres",
      schema: "public",
      tableName: "permission_groups",
      columnNames: ["id", "name", "permissions"],
      columnTypes: ["int4", "text", "_text"],
      rows: [
        [
          { t: "I64", v: 1 },
          { t: "Str", v: "Super Admin" },
          { t: "Json", v: '["*"]' },
        ],
      ],
      qIdent,
    });

    expect(sql).toContain(
      `INSERT INTO "public"."permission_groups" ("id", "name", "permissions") VALUES`
    );
    expect(sql).toContain(`(1, 'Super Admin', ARRAY['*']::text[])`);
    expect(sql).not.toContain("'[\"*\"]'");
  });
});
