import { describe, expect, it } from "vitest";
import { getResolvedTheme } from "./theme";

describe("getResolvedTheme", () => {
  it("reads dark from the document root", () => {
    document.documentElement.classList.add("dark");
    document.documentElement.dataset.theme = "dark";
    expect(getResolvedTheme()).toBe("dark");
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.theme;
    expect(getResolvedTheme()).toBe("light");
  });
});
