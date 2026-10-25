import { describe, expect, it } from "vitest";
import { nullableLabel, parseNullable } from "./columnFlags";

describe("parseNullable", () => {
  it("reads every spelling the app uses", () => {
    for (const yes of [true, "YES", "yes", "true", "TRUE", "1", "NULL", "Y"]) {
      expect(parseNullable(yes)).toBe(true);
    }
    for (const no of [false, "NO", "no", "false", "FALSE", "0", "NOT NULL"]) {
      expect(parseNullable(no)).toBe(false);
    }
  });

  it("is undefined when it says neither", () => {
    for (const unknown of [undefined, null, "", "  ", "maybe"]) {
      expect(parseNullable(unknown)).toBeUndefined();
    }
  });
});

describe("nullableLabel", () => {
  it("shows catalog booleans and editor values the same way", () => {
    expect(nullableLabel(true)).toBe("YES");
    expect(nullableLabel("YES")).toBe("YES");
    expect(nullableLabel(false)).toBe("NO");
    expect(nullableLabel("false")).toBe("NO");
    expect(nullableLabel("")).toBe("");
  });
});
