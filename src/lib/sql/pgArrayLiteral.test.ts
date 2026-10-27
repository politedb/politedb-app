import { describe, expect, it } from "vitest";
import { pgArrayValueSql } from "./pgArrayLiteral";
import { formatSqlValue } from "./sqlDialect";
import { generateInsertSqlFromPatches } from "src/lib/patches/generateSql";
import { jsonArrayToPgArraySql } from "src/screens/connection/hooks/sqlInsertLiteral";

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

describe("pgArrayValueSql", () => {
  it("writes built-in element types as ARRAY[…]::type[]", () => {
    expect(pgArrayValueSql('["a", null, "it\'s"]', "_text", quote)).toBe(
      "ARRAY['a', NULL, 'it''s']::text[]"
    );
    expect(pgArrayValueSql("[1, 2]", "_int4", quote)).toBe(
      "ARRAY[1, 2]::int4[]"
    );
  });

  it("writes other element types (enums) as a literal typed by the column", () => {
    // Mixed case and other schemas are not in the reported name: no cast.
    expect(pgArrayValueSql('["admin", null]', "_UserRole", quote)).toBe(
      `'{"admin",NULL}'`
    );
    expect(pgArrayValueSql("[]", "_role", quote)).toBe("'{}'");
    expect(
      pgArrayValueSql(
        '["a,b", "NULL", "q\\"x", "b\\\\s", "{}"]',
        "_mood",
        quote
      )
    ).toBe(String.raw`'{"a,b","NULL","q\"x","b\\s","{}"}'`);
  });

  it("leaves text that is not a JSON array to the caller", () => {
    expect(pgArrayValueSql("{admin}", "_role", quote)).toBeNull();
    expect(pgArrayValueSql('"x"', "_role", quote)).toBeNull();
  });
});

describe("enum arrays in backups and table edits", () => {
  it("backs them up as array literals", () => {
    expect(jsonArrayToPgArraySql('["admin",null]', "_UserRole")).toBe(
      `'{"admin",NULL}'`
    );
    // A backslash makes the backup's E'…' string, read the same either way.
    expect(jsonArrayToPgArraySql('["a\\\\b"]', "_role")).toBe(
      String.raw`E'{"a\\\\b"}'`
    );
  });

  it("writes them as array SQL in grid edits", () => {
    expect(
      formatSqlValue(
        { t: "Json", v: '["admin",null]' },
        "_user_role",
        "postgres"
      )
    ).toBe(`'{"admin",NULL}'`);
    expect(
      formatSqlValue({ t: "Json", v: '["a",null]' }, "_text", "postgres")
    ).toBe("ARRAY['a', NULL]::text[]");
    // An array literal typed in the editor stays as typed.
    expect(formatSqlValue("{admin,customer}", "_user_role", "postgres")).toBe(
      "'{admin,customer}'"
    );
    // Other engines are untouched.
    expect(formatSqlValue('["a"]', "_text", "mysql")).not.toContain("ARRAY");
  });
});

it("inserts an enum array row from the grid", () => {
  expect(
    generateInsertSqlFromPatches(
      {
        create: {
          data: {
            "new:0": {
              role: { t: "Str", v: "admin" },
              roles: { t: "Json", v: '["admin",null]' },
              __rowKey: "new:0",
            },
          },
        },
      },
      "app",
      "users",
      "postgres",
      [
        { name: "role", db_type: "UserRole" },
        { name: "roles", db_type: "_UserRole" },
      ]
    )
  ).toEqual([
    `INSERT INTO "app"."users" ("role", "roles")\nVALUES ('admin', '{"admin",NULL}');`,
  ]);
});
