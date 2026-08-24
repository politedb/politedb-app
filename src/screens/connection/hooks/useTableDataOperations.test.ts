import { describe, expect, it } from "vitest";
import { buildNewRowPatch } from "./useTableDataOperations";

describe("buildNewRowPatch", () => {
  it("creates one null-backed patch without adding a cached row", () => {
    expect(
      buildNewRowPatch([{ name: "id" }, { name: "name" }], "new_1")
    ).toEqual({
      __rowKey: "new_1",
      id: null,
      name: null,
    });
  });

  it("uses a unique key for each new row", () => {
    const first = buildNewRowPatch([{ name: "id" }]);
    const second = buildNewRowPatch([{ name: "id" }]);
    expect(first.__rowKey).not.toBe(second.__rowKey);
  });
});
