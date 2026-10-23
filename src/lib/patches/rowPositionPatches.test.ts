import { describe, expect, it } from "vitest";
import {
  hasRowPositionPatches,
  withoutRowPositionPatches,
} from "./rowPositionPatches";

describe("rowPositionPatches", () => {
  it("counts only row edits and row deletions", () => {
    expect(hasRowPositionPatches(null)).toBe(false);
    expect(hasRowPositionPatches({ update: { data: {} } })).toBe(false);
    expect(hasRowPositionPatches({ update: { data: { "3": { a: 1 } } } })).toBe(
      true
    );
    expect(hasRowPositionPatches({ delete: { data: { "0": {} } } })).toBe(true);
    expect(
      hasRowPositionPatches({
        create: { data: { new_1: { a: 1 } } },
        update: { structure: { "0": { column_name: "b" } } },
      })
    ).toBe(false);
  });

  it("drops row edits and deletions, keeps new rows and structure", () => {
    const next = withoutRowPositionPatches({
      create: { data: { new_1: { a: 1 } } },
      update: {
        data: { "3": { a: 2 } },
        structure: { "0": { column_name: "b" } },
      },
      delete: { data: { "1": {} } },
    });
    expect(next).toEqual({
      create: { data: { new_1: { a: 1 } } },
      update: { structure: { "0": { column_name: "b" } } },
      delete: {},
    });
    expect(hasRowPositionPatches(next)).toBe(false);
  });
});
