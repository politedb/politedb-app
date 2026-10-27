import { describe, expect, it } from "vitest";
import { filterConnections, sortConnections } from "./connection";

const profile = (id: string, label: string, created_at = 0) =>
  ({ id, label, engine: "postgres", created_at, input: {} }) as never;

const all = [
  profile("a", "Alpha", 3),
  profile("b", "Bravo", 2),
  profile("c", "Charlie", 1),
];

describe("Recently used order", () => {
  it("puts the last opened first and never opened ones last, by name", () => {
    const sorted = sortConnections(all, "used-desc", [], { c: 200, b: 100 });
    expect(sorted.map((p: { id: string }) => p.id)).toEqual(["c", "b", "a"]);
  });

  it("keeps pinned connections on top", () => {
    const sorted = sortConnections(all, "used-desc", ["a"], { c: 200 });
    expect(sorted.map((p: { id: string }) => p.id)).toEqual(["a", "c", "b"]);
  });

  it("also applies to search results", () => {
    const found = filterConnections(all, "a", "used-desc", [], { b: 5 });
    expect(found.map((p: { id: string }) => p.id)).toEqual(["b", "a", "c"]);
  });
});
