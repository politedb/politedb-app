import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clampLauncherPosition,
  DEFAULT_LAUNCHER_POSITION,
  loadLauncherPosition,
  saveLauncherPosition,
} from "./launcherPosition";

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("clampLauncherPosition", () => {
  const viewport = { width: 1000, height: 700 };

  it("keeps a position inside the window", () => {
    expect(
      clampLauncherPosition({ right: 300, bottom: 200 }, viewport, 40)
    ).toEqual({ right: 300, bottom: 200 });
  });

  it("pulls a button dragged past any edge back inside", () => {
    expect(
      clampLauncherPosition({ right: -50, bottom: 5000 }, viewport, 40)
    ).toEqual({ right: 8, bottom: 700 - 40 - 8 });
    expect(
      clampLauncherPosition({ right: 5000, bottom: -3 }, viewport, 40)
    ).toEqual({ right: 1000 - 40 - 8, bottom: 36 });
  });

  it("stays at the edge gap in a window smaller than the button", () => {
    expect(
      clampLauncherPosition(
        { right: 30, bottom: 30 },
        { width: 20, height: 20 },
        40
      )
    ).toEqual({ right: 8, bottom: 36 });
  });

  it("never lets the button cover the status bar", () => {
    expect(
      clampLauncherPosition({ right: 24, bottom: 8 }, viewport, 40)
    ).toEqual({ right: 24, bottom: 36 });
  });
});

describe("launcher position storage", () => {
  it("round-trips a saved position", () => {
    saveLauncherPosition({ right: 120, bottom: 80 });
    expect(loadLauncherPosition()).toEqual({ right: 120, bottom: 80 });
  });

  it("falls back to the default when nothing or garbage is stored", () => {
    expect(loadLauncherPosition()).toEqual(DEFAULT_LAUNCHER_POSITION);
    window.localStorage.setItem(
      "politedb.assistant-launcher-position.v1",
      '{"right":"x"}'
    );
    expect(loadLauncherPosition()).toEqual(DEFAULT_LAUNCHER_POSITION);
    window.localStorage.setItem(
      "politedb.assistant-launcher-position.v1",
      "not json"
    );
    expect(loadLauncherPosition()).toEqual(DEFAULT_LAUNCHER_POSITION);
  });

  it("ignores storage that throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => saveLauncherPosition({ right: 1, bottom: 1 })).not.toThrow();
    expect(loadLauncherPosition()).toEqual(DEFAULT_LAUNCHER_POSITION);
  });
});
