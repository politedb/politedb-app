import { describe, expect, it } from "vitest";
import { tableSidebarNameClass } from "./tableSidebarNameClass";

describe("tableSidebarNameClass", () => {
  it("forces dirty and new colors on the active table", () => {
    expect(
      tableSidebarNameClass({
        isActive: true,
        isNewTable: false,
        hasChanges: true,
      })
    ).toBe("bg-amber-200! text-neutral-600!");
    expect(
      tableSidebarNameClass({
        isActive: true,
        isNewTable: true,
        hasChanges: false,
      })
    ).toBe("bg-green-200! text-emerald-900!");
  });

  it("lets the button own dirty and new colors when inactive", () => {
    expect(
      tableSidebarNameClass({
        isActive: false,
        isNewTable: false,
        hasChanges: true,
      })
    ).toBeUndefined();
    expect(
      tableSidebarNameClass({
        isActive: false,
        isNewTable: true,
        hasChanges: false,
      })
    ).toBeUndefined();
  });

  it("prefers dirty over new when both apply", () => {
    expect(
      tableSidebarNameClass({
        isActive: true,
        isNewTable: true,
        hasChanges: true,
      })
    ).toBe("bg-amber-200! text-neutral-600!");
  });
});
