import { describe, expect, it } from "vitest";
import { pgArrayValueSql } from "./pgArrayLiteral";
import { formatSqlValue } from "./sqlDialect";
import { generateInsertSqlFromPatches } from "src/lib/patches/generateSql";
import { jsonArrayToPgArraySql } from "src/screens/connection/hooks/sqlInsertLiteral";

const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;

describe("pgArrayValueSql", () => {
  it("writes every array as a literal typed by the destination column", () => {
    expect(pgArrayValueSql('["a", null, "it\'s"]', quote)).toBe(
      `'{"a",NULL,"it''s"}'`
    );
    expect(pgArrayValueSql("[1, 2, true]", quote)).toBe(`'{"1","2","true"}'`);
    expect(pgArrayValueSql('["admin", null]', quote)).toBe(`'{"admin",NULL}'`);
    expect(pgArrayValueSql("[]", quote)).toBe("'{}'");
    expect(pgArrayValueSql("[[1, null], [3, 4]]", quote)).toBe(
      `'{{"1",NULL},{"3","4"}}'`
    );
    expect(
      pgArrayValueSql('["a,b", "NULL", "q\\"x", "b\\\\s", "{}", ""]', quote)
    ).toBe(String.raw`'{"a,b","NULL","q\"x","b\\s","{}",""}'`);
  });

  it("leaves text that is not a JSON array to the caller", () => {
    expect(pgArrayValueSql("{admin}", quote)).toBeNull();
    expect(pgArrayValueSql('"x"', quote)).toBeNull();
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
    ).toBe(`'{"a",NULL}'`);
    // An enum named like a built-in type is not cast to that type.
    expect(
      formatSqlValue({ t: "Json", v: '["admin",null]' }, "_Text", "postgres")
    ).toBe(`'{"admin",NULL}'`);
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

describe("PostgreSQL grid strings with backslashes", () => {
  it("are E'…' strings, the same with standard_conforming_strings on or off", () => {
    expect(formatSqlValue("a\\b 'q'", "text", "postgres")).toBe(
      String.raw`E'a\\b ''q'''`
    );
    expect(formatSqlValue("plain 'q'", "text", "postgres")).toBe(
      "'plain ''q'''"
    );
    // Array elements escape quotes with backslashes too.
    expect(
      formatSqlValue({ t: "Json", v: '["q\\"x", null]' }, "_text", "postgres")
    ).toBe(String.raw`E'{"q\\"x",NULL}'`);
    // bytea[] elements arrive as \x hex text.
    expect(
      formatSqlValue(
        { t: "Json", v: '["\\\\x00ff", null]' },
        "_bytea",
        "postgres"
      )
    ).toBe(String.raw`E'{"\\\\x00ff",NULL}'`);
    // Other engines keep their quoting.
    expect(formatSqlValue("a\\b", "text", "sqlite")).toBe("'a\\b'");
  });
});
