import { describe, expect, it, vi } from "vitest";
import {
  isModalDialogOpen,
  isOpenSettingsShortcut,
  OPEN_SETTINGS_EVENT,
  requestOpenSettings,
  takeOpenSettingsRequest,
} from "./openSettings";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("isOpenSettingsShortcut", () => {
  it("is ⌘, on macOS and Ctrl+, elsewhere", () => {
    expect(isOpenSettingsShortcut(key({ key: ",", metaKey: true }), true)).toBe(
      true
    );
    expect(
      isOpenSettingsShortcut(key({ key: ",", ctrlKey: true }), false)
    ).toBe(true);
    expect(isOpenSettingsShortcut(key({ key: ",", ctrlKey: true }), true)).toBe(
      false
    );
    expect(
      isOpenSettingsShortcut(
        key({ key: ",", metaKey: true, shiftKey: true }),
        true
      )
    ).toBe(false);
    expect(
      isOpenSettingsShortcut(key({ key: ",", metaKey: false }), true)
    ).toBe(false);
    expect(isOpenSettingsShortcut(key({ key: ".", metaKey: true }), true)).toBe(
      false
    );
  });
});

describe("open settings request", () => {
  it("is kept until taken once, and announced", () => {
    const heard = vi.fn();
    window.addEventListener(OPEN_SETTINGS_EVENT, heard);

    requestOpenSettings();
    expect(heard).toHaveBeenCalledTimes(1);
    expect(takeOpenSettingsRequest()).toBe(true);
    expect(takeOpenSettingsRequest()).toBe(false);

    window.removeEventListener(OPEN_SETTINGS_EVENT, heard);
  });
});

describe("isModalDialogOpen", () => {
  it("sees an open modal dialog", () => {
    expect(isModalDialogOpen()).toBe(false);
    const dialog = document.createElement("div");
    dialog.setAttribute("aria-modal", "true");
    document.body.appendChild(dialog);
    expect(isModalDialogOpen()).toBe(true);
    dialog.remove();

    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    document.body.appendChild(menu);
    expect(isModalDialogOpen()).toBe(true);
    menu.remove();
    expect(isModalDialogOpen()).toBe(false);
  });
});
