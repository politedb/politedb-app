import { describe, expect, it } from "vitest";
import { tableCellBackground } from "./tableCellBackground";

describe("tableCellBackground", () => {
  it("keeps a selected new row green", () => {
    expect(
      tableCellBackground({
        dirty: false,
        deleted: false,
        newRow: true,
        selected: true,
        focused: true,
      })
    ).toBe("#dcfce7");
  });

  it("uses normal selection color for persisted rows", () => {
    expect(
      tableCellBackground({
        dirty: false,
        deleted: false,
        newRow: false,
        selected: true,
        focused: true,
      })
    ).toBe("#bedbff");
  });
});
