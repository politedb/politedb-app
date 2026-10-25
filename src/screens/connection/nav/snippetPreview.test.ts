import { describe, expect, it, vi } from "vitest";

vi.mock("src/stores/snippets", () => ({ useSnippetsStore: vi.fn() }));

import { snippetPreview } from "./LeftNavSnippetsPane";

describe("snippetPreview", () => {
  it("shows the first non-empty line, trimmed", () => {
    expect(snippetPreview("\n   \n  SELECT *\nFROM users")).toBe("SELECT *");
    expect(snippetPreview("")).toBe("");
  });
});
