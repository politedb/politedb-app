import { describe, expect, it } from "vitest";
import { tableRenameTarget } from "./tableRename";

describe("tableRenameTarget", () => {
  it("is no rename for blank, the same name, or it with spaces", () => {
    expect(tableRenameTarget("", "items")).toBeNull();
    expect(tableRenameTarget("   ", "items")).toBeNull();
    expect(tableRenameTarget("items", "items")).toBeNull();
    expect(tableRenameTarget(" items ", "items")).toBeNull();
    expect(tableRenameTarget(undefined, "items")).toBeNull();
  });

  it("renames to the trimmed name", () => {
    expect(tableRenameTarget(" goods ", "items")).toBe("goods");
  });

  it("compares an existing name with spaces exactly", () => {
    // Undo puts back the exact current name.
    expect(tableRenameTarget(" items ", " items ")).toBeNull();
    // Typing the name without the spaces is a real rename.
    expect(tableRenameTarget("items", " items ")).toBe("items");
    expect(tableRenameTarget("goods", " items ")).toBe("goods");
  });
});
