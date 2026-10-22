import { describe, expect, it } from "vitest";
import { detectSqlKind } from "./analytics";

describe("detectSqlKind", () => {
  it("reports known statement kinds", () => {
    expect(detectSqlKind("select 1")).toBe("SELECT");
    expect(detectSqlKind("  WITH x AS (select 1) select * from x")).toBe(
      "WITH"
    );
    expect(detectSqlKind("insert into t values (1)")).toBe("INSERT");
    expect(detectSqlKind("SELECT(1)")).toBe("SELECT");
  });

  it("skips leading comments instead of sending them", () => {
    expect(detectSqlKind("--CUSTOMER_SECRET\nSELECT 1")).toBe("SELECT");
    expect(detectSqlKind("/* private_customer_orders */ delete from t")).toBe(
      "DELETE"
    );
    expect(detectSqlKind("-- a\n/* b */\n  -- c\nupdate t set x = 1")).toBe(
      "UPDATE"
    );
  });

  it("never reports what the user typed", () => {
    expect(detectSqlKind("private_customer_orders")).toBe("OTHER");
    expect(detectSqlKind("--only a comment")).toBe("UNKNOWN");
    expect(detectSqlKind("/* unterminated secret")).toBe("UNKNOWN");
    expect(detectSqlKind("")).toBe("UNKNOWN");
    expect(detectSqlKind("'quoted secret'")).toBe("UNKNOWN");
  });
});
