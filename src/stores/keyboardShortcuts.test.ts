import { describe, expect, it, vi } from "vitest";
import {
  formatShortcutLabel,
  isDefaultShortcut,
  reservedShortcutOwner,
  useKeyboardShortcutsStore,
} from "./keyboardShortcuts";

describe("formatShortcutLabel", () => {
  it("writes macOS shortcuts in the standard order, without separators", () => {
    expect(formatShortcutLabel("Mod+K", { isMac: true })).toBe("⌘K");
    expect(formatShortcutLabel("Mod+Shift+S", { isMac: true })).toBe("⇧⌘S");
    expect(formatShortcutLabel("Mod+Alt+Ctrl+P", { isMac: true })).toBe("⌃⌥⌘P");
  });

  it("keeps the Windows/Linux form", () => {
    expect(formatShortcutLabel("Mod+Shift+S", { isMac: false })).toBe(
      "Ctrl+Shift+S"
    );
  });
});

describe("isDefaultShortcut", () => {
  it("tells a changed shortcut from its default", () => {
    expect(isDefaultShortcut("openSearch", "Mod+K")).toBe(true);
    expect(isDefaultShortcut("openSearch", "Mod+Shift+K")).toBe(false);
  });
});

describe("reserved shortcuts", () => {
  it("keeps Cmd/Ctrl+, for Settings", () => {
    expect(reservedShortcutOwner("Mod+,")).toBe("Settings");
    expect(reservedShortcutOwner("Mod+K")).toBeUndefined();
  });

  it("keeps the connection tab keys", () => {
    expect(reservedShortcutOwner("Mod+1")).toBe("a connection tab");
    expect(reservedShortcutOwner("Mod+9")).toBe("a connection tab");
    expect(reservedShortcutOwner("Ctrl+Tab")).toBe("the next connection tab");
    expect(reservedShortcutOwner("Shift+Ctrl+Tab")).toBe(
      "the previous connection tab"
    );
    expect(reservedShortcutOwner("Mod+Shift+1")).toBeUndefined();
  });

  it("refuses to assign a reserved binding", () => {
    const before = useKeyboardShortcutsStore.getState().shortcuts.closeCurrent;
    useKeyboardShortcutsStore.getState().setShortcut("closeCurrent", "Mod+,");
    expect(useKeyboardShortcutsStore.getState().shortcuts.closeCurrent).toBe(
      before
    );
  });

  it("drops a stored binding that clashes with a reserved one", async () => {
    const getItem = vi
      .spyOn(Storage.prototype, "getItem")
      .mockReturnValue(JSON.stringify({ closeCurrent: "Mod+," }));
    vi.resetModules();
    const fresh = await import("./keyboardShortcuts");
    expect(
      fresh.useKeyboardShortcutsStore.getState().shortcuts.closeCurrent
    ).toBe("Mod+W");
    getItem.mockRestore();
  });
});
