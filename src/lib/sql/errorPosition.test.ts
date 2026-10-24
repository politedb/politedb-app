import { describe, expect, it } from "vitest";
import {
  errorRangeInStatement,
  parseSqlErrorPosition,
  runStatementStarts,
} from "./errorPosition";
import { splitSqlStatements } from "src/components/editor/splitSqlStatements";

const pgError = (line: number, text: string, caret: number) =>
  `Query 1 ERROR:\nERROR at Line ${line}:\nERROR: column "bad" does not exist\nLINE ${line}: ${text}\n${" ".repeat(caret)}^`;

describe("parseSqlErrorPosition", () => {
  it("reads the line and caret column", () => {
    expect(parseSqlErrorPosition(pgError(1, "SELECT bad FROM t", 7))).toEqual({
      line: 1,
      column: 8,
    });
    expect(parseSqlErrorPosition(pgError(2, "FROM missing", 5))).toEqual({
      line: 2,
      column: 6,
    });
  });

  it("counts the caret in characters and returns a string column", () => {
    // 9 characters before 'b' ("é" is one character).
    expect(parseSqlErrorPosition(pgError(1, "SELECT é bad", 9))).toEqual({
      line: 1,
      column: 10,
    });
    // An emoji is one character but two string units.
    const line = "SELECT '😀', bad";
    const pos = parseSqlErrorPosition(pgError(1, line, 12))!;
    expect(line.slice(pos.column - 1, pos.column + 2)).toBe("bad");
  });

  it("returns null without a position", () => {
    expect(parseSqlErrorPosition("ERROR: permission denied")).toBeNull();
    expect(parseSqlErrorPosition(undefined)).toBeNull();
  });
});

describe("errorRangeInStatement", () => {
  it("covers the word at the position", () => {
    const sql = "SELECT 1\nFROM missing_table t";
    const range = errorRangeInStatement(sql, { line: 2, column: 6 })!;
    expect(sql.slice(range.start, range.end)).toBe("missing_table");
  });

  it("covers a quoted name, or one character", () => {
    const sql = 'SELECT "Bad Col" , ) FROM t';
    let range = errorRangeInStatement(sql, { line: 1, column: 8 })!;
    expect(sql.slice(range.start, range.end)).toBe('"Bad Col"');
    range = errorRangeInStatement(sql, { line: 1, column: 20 })!;
    expect(sql.slice(range.start, range.end)).toBe(")");
  });

  it("ignores positions outside the statement", () => {
    expect(
      errorRangeInStatement("SELECT 1", { line: 3, column: 1 })
    ).toBeNull();
    expect(
      errorRangeInStatement("SELECT 1", { line: 1, column: 40 })
    ).toBeNull();
  });
});

describe("runStatementStarts", () => {
  it("places each statement of a run, ignoring SQL inside strings", () => {
    const run = "  SELECT 'SELECT bad';\n  SELECT bad;";
    const parts = runStatementStarts(run, splitSqlStatements);
    // Statements as the runner sends them (no trailing semicolon).
    expect(parts.map((p) => p.text)).toEqual([
      "SELECT 'SELECT bad'",
      "SELECT bad",
    ]);
    for (const part of parts) {
      expect(run.slice(part.start, part.start + part.text.length)).toBe(
        part.text
      );
    }
  });
});
