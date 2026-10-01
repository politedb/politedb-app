import { describe, expect, it } from "vitest";
import {
  clickhouseDecimalScale,
  formatClickhouseDecimalForSql,
  normalizeClickhouseDbType,
  unwrapClickhouseType,
} from "./clickhouse";

describe("clickhouseTypes", () => {
  it("unwraps Nullable decimal types", () => {
    expect(unwrapClickhouseType("Nullable(Decimal(18, 2))")).toBe(
      "Decimal(18, 2)"
    );
    expect(clickhouseDecimalScale("Nullable(Decimal(18, 2))")).toBe(2);
  });

  it("normalizes decimal type with separate numeric_scale", () => {
    expect(normalizeClickhouseDbType("Decimal64(9)", "2")).toBe(
      "Decimal64(9, 2)"
    );
  });

  it("formats human decimals for SQL, not scaled integers", () => {
    expect(formatClickhouseDecimalForSql(6941, 2)).toBe("6941.00");
  });
});
