import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv";

describe("parseCsv", () => {
  it("detects the separator and reports it", () => {
    const parsed = parseCsv("id;name\n1;Ada\n2;Grace");
    expect(parsed.delimiter).toBe(";");
    expect(parsed.headers).toEqual(["id", "name"]);
    expect(parsed.rows[0]).toEqual(["1", "Ada"]);
  });

  it("uses a chosen separator", () => {
    const parsed = parseCsv("a,b\t1\n2,3\t4", "\t");
    expect(parsed.delimiter).toBe("\t");
    expect(parsed.headers).toEqual(["a,b", "1"]);
  });
});
