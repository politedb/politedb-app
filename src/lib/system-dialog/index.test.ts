import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ message: vi.fn() }));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  ask: vi.fn(),
  confirm: vi.fn(),
  message: (...a: unknown[]) => mocks.message(...a),
  open: vi.fn(),
  save: vi.fn(),
}));

import { chooseDialog } from "./index";

const options = {
  title: "PoliteDB Pro",
  primary: "Enter license key",
  secondary: "See plans & pricing",
  cancel: "Cancel",
};

describe("chooseDialog", () => {
  beforeEach(() => {
    mocks.message.mockReset();
    (window as any).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as any).__TAURI_INTERNALS__;
    vi.restoreAllMocks();
  });

  it("asks with yes/no/cancel buttons and maps the custom labels", async () => {
    mocks.message.mockResolvedValueOnce("Enter license key");
    expect(await chooseDialog("Body", options)).toBe("primary");
    expect(mocks.message).toHaveBeenCalledWith("Body", {
      title: "PoliteDB Pro",
      kind: undefined,
      buttons: {
        yes: "Enter license key",
        no: "See plans & pricing",
        cancel: "Cancel",
      },
    });
    mocks.message.mockResolvedValueOnce("See plans & pricing");
    expect(await chooseDialog("Body", options)).toBe("secondary");
  });

  it("maps the standard results too", async () => {
    for (const [result, expected] of [
      ["Yes", "primary"],
      ["Ok", "primary"],
      ["No", "secondary"],
      ["Cancel", "cancel"],
    ] as const) {
      mocks.message.mockResolvedValueOnce(result);
      expect(await chooseDialog("Body", options)).toBe(expected);
    }
  });

  it("treats closing the dialog or an unknown result as cancel", async () => {
    for (const result of ["Cancel", "", "Something else"]) {
      mocks.message.mockResolvedValueOnce(result);
      expect(await chooseDialog("Body", options)).toBe("cancel");
    }
  });

  it("uses ok/cancel buttons without a secondary choice", async () => {
    mocks.message.mockResolvedValueOnce("No");
    const choice = await chooseDialog("Body", {
      ...options,
      secondary: undefined,
    });
    expect(mocks.message.mock.calls[0][1].buttons).toEqual({
      ok: "Enter license key",
      cancel: "Cancel",
    });
    // "No" cannot come from an ok/cancel dialog; never treat it as a choice.
    expect(choice).toBe("cancel");
  });

  it("falls back to window.confirm outside Tauri", async () => {
    delete (window as any).__TAURI_INTERNALS__;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    expect(await chooseDialog("Body", options)).toBe("primary");
    confirm.mockReturnValue(false);
    expect(await chooseDialog("Body", options)).toBe("cancel");
    expect(mocks.message).not.toHaveBeenCalled();
  });
});
