import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyUiDensityPreference,
  getAppliedUiDensity,
  getStoredUiDensityPreference,
  isUiDensityPreference,
} from "./density";

afterEach(() => {
  window.localStorage.clear();
  document.documentElement.removeAttribute("data-density");
  vi.restoreAllMocks();
});

describe("UI density preference", () => {
  it("falls back to comfortable for invalid settings", () => {
    window.localStorage.setItem(
      "politedb:app-settings:v1",
      JSON.stringify({ density: "tiny" })
    );

    expect(getStoredUiDensityPreference()).toBe("comfortable");
    expect(isUiDensityPreference("tiny")).toBe(false);
  });

  it("applies density and emits a live update event", () => {
    const listener = vi.fn();
    window.addEventListener("politedb:densitychange", listener);

    applyUiDensityPreference("compact");

    expect(document.documentElement.dataset.density).toBe("compact");
    expect(getAppliedUiDensity()).toBe("compact");
    expect(listener).toHaveBeenCalledOnce();
    window.removeEventListener("politedb:densitychange", listener);
  });
});
