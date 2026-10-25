import { describe, expect, it } from "vitest";
import { mysqlDefaultFromCatalog } from "./sqlDialect";

describe("mysqlDefaultFromCatalog (MySQL: raw text)", () => {
  it("quotes text, even text that looks like SQL", () => {
    expect(mysqlDefaultFromCatalog("draft", "", "mysql")).toBe("'draft'");
    expect(mysqlDefaultFromCatalog("a\\b", "", "mysql")).toBe("'a\\\\b'");
    expect(mysqlDefaultFromCatalog("'hi'", "", "mysql")).toBe("'''hi'''");
    expect(mysqlDefaultFromCatalog("NULL", "", "mysql")).toBe("'NULL'");
    expect(
      mysqlDefaultFromCatalog("CURRENT_TIMESTAMP", "", "mysql", "varchar(20)")
    ).toBe("'CURRENT_TIMESTAMP'");
  });

  it("never lets a crafted default end the statement", () => {
    const crafted = "'x'; DROP TABLE users; -- '";
    const restated = mysqlDefaultFromCatalog(crafted, "", "mysql")!;
    expect(restated).toBe("'''x''; DROP TABLE users; -- '''");
    // One literal: every inner quote is doubled.
    expect(restated.slice(1, -1).replace(/''/g, "")).not.toContain("'");
  });

  it("keeps numbers, bit/hex literals and time keywords on time columns", () => {
    expect(mysqlDefaultFromCatalog("-1.5", "", "mysql", "decimal(5,2)")).toBe(
      "-1.5"
    );
    expect(mysqlDefaultFromCatalog("b'1'", "", "mysql", "bit(1)")).toBe("b'1'");
    expect(
      mysqlDefaultFromCatalog("CURRENT_TIMESTAMP", "", "mysql", "timestamp")
    ).toBe("CURRENT_TIMESTAMP");
    expect(
      mysqlDefaultFromCatalog(
        "CURRENT_TIMESTAMP(3)",
        "DEFAULT_GENERATED",
        "mysql",
        "datetime(3)"
      )
    ).toBe("CURRENT_TIMESTAMP(3)");
  });

  it("refuses other expression defaults", () => {
    expect(() =>
      mysqlDefaultFromCatalog("uuid()", "DEFAULT_GENERATED", "mysql")
    ).toThrow(/expression/);
    expect(() =>
      mysqlDefaultFromCatalog(
        "concat(_utf8mb4\\'a\\')",
        "DEFAULT_GENERATED",
        "mysql"
      )
    ).toThrow(/expression/);
  });

  it("is undefined without a default", () => {
    expect(mysqlDefaultFromCatalog(null, "", "mysql")).toBeUndefined();
    expect(mysqlDefaultFromCatalog(undefined, "", "mysql")).toBeUndefined();
  });
});

describe("mysqlDefaultFromCatalog (MariaDB: SQL text)", () => {
  it("keeps one well-formed literal or keyword", () => {
    for (const value of [
      "'draft'",
      "'it''s'",
      "'a\\'b'",
      "NULL",
      "current_timestamp()",
      "7",
      "b'1'",
      "x'4f'",
    ]) {
      expect(mysqlDefaultFromCatalog(value, "", "mariadb")).toBe(value);
    }
  });

  it("refuses anything else, including a crafted literal", () => {
    for (const value of [
      "'x'; DROP TABLE users; -- '",
      "'a' 'b'",
      "uuid()",
      "concat('a','b')",
    ]) {
      expect(() => mysqlDefaultFromCatalog(value, "", "mariadb")).toThrow(
        /expression/
      );
    }
  });
});

describe("mysqlDefaultFromCatalog on text columns (MySQL)", () => {
  it("keeps number- and bit-looking text as text", () => {
    for (const value of ["001", "-01.50", "b'1'", "x'41'"]) {
      for (const type of ["varchar(10)", "enum('001','b''1''')", "set('a')"]) {
        const restated = mysqlDefaultFromCatalog(value, "", "mysql", type)!;
        expect(restated.startsWith("'")).toBe(true);
      }
    }
    expect(mysqlDefaultFromCatalog("001", "", "mysql", "varchar(10)")).toBe(
      "'001'"
    );
  });
});
