import { describe, expect, it } from "vitest";
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
