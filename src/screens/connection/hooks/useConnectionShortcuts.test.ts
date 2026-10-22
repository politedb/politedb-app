import { renderHook } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

// zustand runs on React's hooks; keep the real helpers and feed plain state.
vi.mock("src/stores/keyboardShortcuts", async (importActual) => {
  const actual =
    await importActual<typeof import("src/stores/keyboardShortcuts")>();
  const defaults = Object.fromEntries(
    actual.SHORTCUT_DEFINITIONS.map((d) => [d.id, d.defaultBinding])
  );
  return {
    ...actual,
    useKeyboardShortcutsStore: (select: (s: unknown) => unknown) =>
      select({ shortcuts: defaults }),
  };
});

import { useConnectionShortcuts } from "./useConnectionShortcuts";

function setup() {
  const insertSnippetByHotkey = vi.fn(() => true);
  renderHook(() =>
    useConnectionShortcuts({
      activeWindowId: null,
      activeProfileScreen: "tab-1",
      actions: {
        openSql: vi.fn(),
        beforeSaveChanges: vi.fn(),
        saveChanges: vi.fn(),
        refresh: vi.fn(),
        closeWindow: vi.fn(),
        closeTab: vi.fn(),
        insertSnippetByHotkey,
      },
    })
  );
  return insertSnippetByHotkey;
}

const press = (init: KeyboardEventInit) =>
  window.dispatchEvent(
    new KeyboardEvent("keydown", { bubbles: true, ...init })
  );

describe("useConnectionShortcuts snippet hotkeys", () => {
  it("never runs a snippet on the Settings chord, on either platform", () => {
    // A snippet saved with Mod+, before the chord was reserved.
    const insert = setup();
    press({ key: ",", metaKey: true });
    press({ key: ",", ctrlKey: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it("still runs snippets on other hotkeys", () => {
    const insert = setup();
    press({ key: "1", ctrlKey: true, altKey: true });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
