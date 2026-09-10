import { describe, expect, it } from "vitest";
import { selectionRowClass, tableMutationRowClass } from "./selectionClasses";

describe("table state classes", () => {
  it("maps row selection states", () => {
    expect(selectionRowClass(false, true)).toBeUndefined();
    expect(selectionRowClass(true, true)).toBe("bg-selected!");
    expect(selectionRowClass(true, false)).toBe(
      "bg-selected-unfocused! text-neutral-500!"
    );
  });

  it("maps add and delete states with delete taking precedence", () => {
    expect(tableMutationRowClass(false, false)).toBe("");
    expect(tableMutationRowClass(false, true)).toBe("bg-new!");
    expect(tableMutationRowClass(true, false)).toBe("bg-deleted!");
    expect(tableMutationRowClass(true, true)).toBe("bg-deleted!");
  });
});
