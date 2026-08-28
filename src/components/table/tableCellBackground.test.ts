import { describe, expect, it } from "vitest";
import { tableCellBackground } from "./tableCellBackground";

describe("tableCellBackground", () => {
  it("uses selection color for a selected new row", () => {
    expect(
      tableCellBackground({
        dirty: false,
        deleted: false,
        newRow: true,
        selected: true,
        focused: true,
      })
    ).toBe("#bedbff");
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

  it("uses dark canvas colors when theme is dark", () => {
    expect(
      tableCellBackground(
        {
          dirty: false,
          deleted: false,
          newRow: false,
          selected: true,
          focused: true,
        },
        "dark"
      )
    ).toBe("#264f78");
  });
});
