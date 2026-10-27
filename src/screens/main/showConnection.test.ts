import { describe, expect, it } from "vitest";
import { groupFilterShowing } from "./showConnection";

const groups = { a: ["g1"], b: ["g2"] };

describe("groupFilterShowing", () => {
  it("keeps the group when the connection is in it", () => {
    expect(groupFilterShowing("a", "g1", groups)).toBe("g1");
  });

  it("drops a group that would hide the connection", () => {
    expect(groupFilterShowing("b", "g1", groups)).toBeUndefined();
    expect(groupFilterShowing("ungrouped", "g1", groups)).toBeUndefined();
  });

  it("leaves All as it is", () => {
    expect(groupFilterShowing("a", undefined, groups)).toBeUndefined();
  });
});
