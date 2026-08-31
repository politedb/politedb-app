import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUiFontPreference,
  getStoredUiFontPreference,
  getUiFontStack,
  isUiFontPreference,
  UI_FONT_OPTIONS,
  UI_FONT_PREFERENCES,
} from "./uiFont";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-ui-font");
  document.documentElement.style.removeProperty("--font-ui");
  vi.restoreAllMocks();
});

describe("UI font preference", () => {
  it("falls back to bundled Inter for old or invalid settings", () => {
    window.localStorage.setItem(
      "politedb:app-settings:v1",
      JSON.stringify({ uiFont: "unknown-font" })
    );

    expect(getStoredUiFontPreference()).toBe("inter");
    expect(isUiFontPreference("unknown-font")).toBe(false);
  });

  it("applies the selected font stack and emits a redraw event", () => {
    const listener = vi.fn();
    window.addEventListener("politedb:fontchange", listener);

    applyUiFontPreference("georgia");

    expect(document.documentElement.dataset.uiFont).toBe("georgia");
    expect(document.documentElement.style.getPropertyValue("--font-ui")).toBe(
      getUiFontStack("georgia")
    );
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("politedb:fontchange", listener);
  });

  it("provides a portable fallback for every font option", () => {
    expect(UI_FONT_OPTIONS.map((option) => option.value)).toEqual(
      UI_FONT_PREFERENCES
    );

    for (const preference of UI_FONT_PREFERENCES) {
      expect(getUiFontStack(preference)).toMatch(
        /(?:sans-serif|serif|monospace)$/
      );
      expect(isUiFontPreference(preference)).toBe(true);
    }
  });
});
