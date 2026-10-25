import { describe, expect, it } from "vitest";
import { canvasOptions, schemaEditorRows } from "./schemaEditorRows";

describe("schemaEditorRows", () => {
  it("prefers the edited copy, else what loaded, none on error", () => {
    expect(schemaEditorRows([1], [2], null)).toEqual([1]);
    expect(schemaEditorRows([], [2], null)).toEqual([2]);
    expect(schemaEditorRows([], null, null)).toEqual([]);
    expect(schemaEditorRows([1], [2], "failed")).toEqual([]);
  });
});

describe("canvasOptions", () => {
  it("turns plain strings into label/value pairs", () => {
    expect(canvasOptions(["a", { label: "B", value: "b" }])).toEqual([
      { label: "a", value: "a" },
      { label: "B", value: "b" },
    ]);
    expect(canvasOptions(undefined)).toBeUndefined();
  });
});
