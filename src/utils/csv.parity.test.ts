import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvRecords } from "./csv";

/** Same cases as `records_match_the_preview_rules` in csv_import.rs. */
describe("CSV records follow the import's rules", () => {
  const parse = (t: string) => parseCsvRecords(t, ",");

  it("drops a BOM and adds nothing for a trailing newline", () => {
    expect(parse("﻿id,name\n1,Ada\n")).toEqual([
      ["id", "name"],
      ["1", "Ada"],
    ]);
  });

  it("skips blank lines anywhere; CRLF and CR end records", () => {
    expect(parse("\n\nid\r\n\r\n1\r2\n\n")).toEqual([["id"], ["1"], ["2"]]);
  });

  it("keeps a quoted empty value as a record", () => {
    expect(parse('name\n""\n')).toEqual([["name"], [""]]);
  });

  it("keeps delimiters, quotes and newlines inside quotes", () => {
    expect(parse('a,b\n"x,""y""\nz",2')).toEqual([
      ["a", "b"],
      ['x,"y"\nz', "2"],
    ]);
  });

  it("rejects an unterminated quote", () => {
    expect(() => parse('a\n"open')).toThrow();
  });

  it("keeps a quote inside an unquoted value as a character", () => {
    expect(parse('name\na"b"c\n12" widget\n')).toEqual([
      ["name"],
      ['a"b"c'],
      ['12" widget'],
    ]);
  });

  it("rejects text after a closing quote instead of joining it", () => {
    expect(() => parse('name\n"a"oops\n')).toThrow(/closing quote/);
  });

  it("accepts a separator or a line end after a closing quote", () => {
    expect(parse('"a","b"\r\n')).toEqual([["a", "b"]]);
  });

  it.each([",", ";", "\t", "|"])("splits on %j the same way", (d) => {
    expect(parseCsvRecords(`a${d}"b${d}c"\n1${d}2`, d)).toEqual([
      ["a", `b${d}c`],
      ["1", "2"],
    ]);
  });

  it("counts data rows the way the import does", () => {
    const parsed = parseCsv('id;name\n1;"a;b"\n');
    expect(parsed.delimiter).toBe(";");
    expect(parsed.rows).toEqual([["1", "a;b"]]);
  });
});
