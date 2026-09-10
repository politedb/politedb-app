import { afterEach, describe, expect, it, vi } from "vitest";
import { applyThemePreference, getResolvedTheme } from "./theme";

afterEach(() => {
  vi.useRealTimers();
  document.documentElement.classList.remove("dark", "theme-transition");
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themePreference;
});

describe("getResolvedTheme", () => {
  it("reads dark from the document root", () => {
    document.documentElement.classList.add("dark");
    document.documentElement.dataset.theme = "dark";
    expect(getResolvedTheme()).toBe("dark");
    document.documentElement.classList.remove("dark");
    delete document.documentElement.dataset.theme;
    expect(getResolvedTheme()).toBe("light");
  });

  it("animates an explicit theme change and removes the marker", () => {
    vi.useFakeTimers();

    applyThemePreference("dark", { animate: true });

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(
      document.documentElement.classList.contains("theme-transition")
    ).toBe(true);

    vi.advanceTimersByTime(180);

    expect(
      document.documentElement.classList.contains("theme-transition")
    ).toBe(false);
  });

  it("applies the startup theme without animation", () => {
    applyThemePreference("dark");

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(
      document.documentElement.classList.contains("theme-transition")
    ).toBe(false);
  });
});
