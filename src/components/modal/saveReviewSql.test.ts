import { describe, expect, it } from "vitest";
import {
  addColumnSql,
  dropColumnSql,
  quoteIdentifier,
  sqlQuotedStringLiteral,
} from "src/lib/sql/sqlDialect";
import type { DatabaseEngine } from "src/types";
import {
  classifySaveStatement,
  describeDestructiveChanges,
} from "./saveReviewSql";

describe("classifySaveStatement", () => {
  it("marks data-destroying statements", () => {
    for (const sql of [
      'DROP TABLE "public"."users";',
      "TRUNCATE TABLE `shop`.`items`;",
      'ALTER TABLE "public"."users" DROP COLUMN "email";',
      "ALTER TABLE `shop`.`items` DROP COLUMN `note`;",
    ]) {
      expect(classifySaveStatement(sql)).toBe("destructive");
    }
  });

  it("keeps replacements and index rebuilds out of it", () => {
    expect(classifySaveStatement("DROP FUNCTION IF EXISTS f();")).toBe(
      "delete"
    );
    expect(
      classifySaveStatement('DROP INDEX IF EXISTS "shop"."items_name_idx";')
    ).toBe("structure");
    expect(
      classifySaveStatement(
        'ALTER TABLE "t" ADD CONSTRAINT "t_pk" PRIMARY KEY ("id");'
      )
    ).toBe("constraint");
  });

  it("judges only the start of a statement, not literals inside it", () => {
    expect(
      classifySaveStatement(
        "ALTER TABLE `shop`.`items` MODIFY COLUMN `note` varchar(20) DEFAULT '''x''; DROP TABLE users; -- ''';"
      )
    ).toBe("structure");
    expect(
      classifySaveStatement(
        "UPDATE t SET note = 'DROP TABLE users' WHERE id = 1;"
      )
    ).toBe("update");
  });

  it("defaults unknown statements to structure, never to create", () => {
    expect(classifySaveStatement("RENAME TABLE a TO b;")).toBe("structure");
    expect(classifySaveStatement("CREATE TABLE a (id int);")).toBe("create");
  });
});

describe("describeDestructiveChanges", () => {
  it("lists what cannot be undone", () => {
    expect(
      describeDestructiveChanges({
        statements: [
          'ALTER TABLE "t" DROP COLUMN "a";',
          'ALTER TABLE "t" DROP COLUMN "b";',
          'DROP TABLE "x";',
          "TRUNCATE TABLE y;",
          "DROP FUNCTION f();",
          'DROP INDEX "i";',
        ],
        deletedRows: 3,
      })
    ).toEqual([
      "deletes 3 rows",
      "drops 2 columns",
      "drops 1 table",
      "empties 1 table",
    ]);
  });

  it("is empty for safe saves and uses the document noun for Mongo", () => {
    expect(
      describeDestructiveChanges({
        statements: ["UPDATE t SET a = 1;"],
        deletedRows: 0,
      })
    ).toEqual([]);
    expect(
      describeDestructiveChanges({
        statements: [],
        deletedRows: 1,
        rowNoun: { one: "document", many: "documents" },
      })
    ).toEqual(["deletes 1 document"]);
  });
});

describe("statements with tricky text", () => {
  it("ignores DROP COLUMN inside literals, quoted names and comments", () => {
    for (const sql of [
      'ALTER TABLE "public"."t" ADD COLUMN "note" text DEFAULT \' DROP COLUMN x\';',
      "ALTER TABLE `shop`.`items` MODIFY COLUMN `note` varchar(20) DEFAULT 'a'' DROP COLUMN b';",
      'ALTER TABLE "drop column archive" ADD COLUMN "c" int;',
      "ALTER TABLE t ADD COLUMN c int; -- DROP COLUMN d",
    ]) {
      expect(classifySaveStatement(sql)).toBe("structure");
      expect(
        describeDestructiveChanges({ statements: [sql], deletedRows: 0 })
      ).toEqual([]);
    }
  });

  it("still finds real drops with quoted names on every engine", () => {
    for (const sql of [
      'ALTER TABLE "public"."users" DROP COLUMN "drop column";',
      "ALTER TABLE `shop`.`items` DROP COLUMN `note`;",
      "ALTER TABLE [dbo].[items] DROP COLUMN [note];",
    ]) {
      expect(classifySaveStatement(sql)).toBe("destructive");
    }
  });

  it("classifies ClickHouse row mutations", () => {
    expect(
      classifySaveStatement("ALTER TABLE `db`.`t` DELETE WHERE `id` = 1;")
    ).toBe("delete");
    expect(
      classifySaveStatement(
        "ALTER TABLE `db`.`t` UPDATE `a` = 'x' WHERE `id` = 1;"
      )
    ).toBe("update");
  });
});

describe("quoting follows the engine", () => {
  // A default made of: a, backslash, quote, " DROP COLUMN x".
  const tricky = "a\\' DROP COLUMN x";
  const addWithDefault = (engine: DatabaseEngine, literal: string) =>
    addColumnSql("public", "t", `"note" text DEFAULT ${literal}`, engine);

  it.each(["postgres", "sqlite", "sqlserver", "duckdb"] as const)(
    "%s: a generated default with a backslash is not a drop",
    (engine) => {
      const sql = addWithDefault(
        engine,
        sqlQuotedStringLiteral(tricky, engine)
      );
      expect(classifySaveStatement(sql, engine)).toBe("structure");
      expect(
        describeDestructiveChanges({
          statements: [sql],
          deletedRows: 0,
          engine,
        })
      ).toEqual([]);
    }
  );

  it.each(["mysql", "mariadb", "clickhouse"] as const)(
    "%s: backslash escapes are read as escapes",
    (engine) => {
      const sql =
        "ALTER TABLE `shop`.`t` ADD COLUMN `note` text DEFAULT 'a\\\\'' DROP COLUMN x';";
      // MySQL: 'a\\'' is a, backslash, then '' (a quote): still one string.
      expect(classifySaveStatement(sql, engine)).toBe("structure");
      const escaped =
        "ALTER TABLE `shop`.`t` ADD COLUMN `n` text DEFAULT 'it\\'s DROP COLUMN x';";
      expect(classifySaveStatement(escaped, engine)).toBe("structure");
    }
  );

  it("postgres: E strings, dollar quotes and nested comments", () => {
    for (const sql of [
      "ALTER TABLE t ADD COLUMN c text DEFAULT E'it\\'s DROP COLUMN x';",
      "ALTER TABLE t ADD COLUMN c text DEFAULT $$ DROP COLUMN x $$;",
      "ALTER TABLE t ADD COLUMN c text DEFAULT $tag$ it's $$ DROP COLUMN x $tag$;",
      "ALTER TABLE t ADD COLUMN c int /* a /* nested */ DROP COLUMN x */;",
    ]) {
      expect(classifySaveStatement(sql, "postgres")).toBe("structure");
    }
  });

  it.each(["postgres", "sqlite", "sqlserver", "mysql", "clickhouse"] as const)(
    "%s: a generated DROP COLUMN is still destructive",
    (engine) => {
      const sql = dropColumnSql("public", "t", "note", engine);
      expect(classifySaveStatement(sql, engine)).toBe("destructive");
      expect(
        describeDestructiveChanges({
          statements: [sql],
          deletedRows: 0,
          engine,
        })
      ).toEqual(["drops 1 column"]);
    }
  );
});

describe("SQL Server bracket identifiers", () => {
  it("keeps ]] inside a name: a safe addition is not a drop", () => {
    for (const sql of [
      addColumnSql("dbo", "a] DROP COLUMN x", "[note] int", "sqlserver"),
      addColumnSql(
        "dbo",
        "t",
        `${quoteIdentifier("x] DROP COLUMN y", "sqlserver")} int`,
        "sqlserver"
      ),
    ]) {
      expect(classifySaveStatement(sql, "sqlserver")).toBe("structure");
      expect(
        describeDestructiveChanges({
          statements: [sql],
          deletedRows: 0,
          engine: "sqlserver",
        })
      ).toEqual([]);
    }
  });

  it("still finds a real drop on a table whose name has ] and '", () => {
    const sql = dropColumnSql("dbo", "a]'", "note", "sqlserver");
    expect(sql).toContain("[a]]']");
    expect(classifySaveStatement(sql, "sqlserver")).toBe("destructive");
    expect(
      describeDestructiveChanges({
        statements: [sql],
        deletedRows: 0,
        engine: "sqlserver",
      })
    ).toEqual(["drops 1 column"]);
  });

  it("treats [ as a subscript on other engines", () => {
    expect(
      classifySaveStatement(
        "ALTER TABLE t ADD COLUMN c int DEFAULT (arr[1]); ",
        "postgres"
      )
    ).toBe("structure");
    expect(
      classifySaveStatement(
        'ALTER TABLE "t" DROP COLUMN "c"; -- x[y[1]]',
        "postgres"
      )
    ).toBe("destructive");
  });
});
