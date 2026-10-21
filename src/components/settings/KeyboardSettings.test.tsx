import { h } from "preact";
import { fireEvent, render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  state: {
    shortcuts: {} as Record<string, string>,
    setShortcut: vi.fn(),
    resetShortcut: vi.fn(),
    resetAll: vi.fn(),
  },
  confirmDialog: vi.fn(),
}));
// zustand runs on React's hooks; keep the real helpers and feed plain state.
vi.mock("src/stores/keyboardShortcuts", async (importActual) => ({
  ...(await importActual<typeof import("src/stores/keyboardShortcuts")>()),
  useKeyboardShortcutsStore: (select: (s: unknown) => unknown) =>
    select(mocks.state),
}));
vi.mock("src/lib/system-dialog", () => ({
  confirmDialog: mocks.confirmDialog,
}));

import { KeyboardSettings } from "./KeyboardSettings";
import { SHORTCUT_DEFINITIONS } from "src/stores/keyboardShortcuts";

const defaults = () =>
  Object.fromEntries(SHORTCUT_DEFINITIONS.map((d) => [d.id, d.defaultBinding]));

beforeEach(() => {
  mocks.state.shortcuts = defaults();
  mocks.state.resetAll.mockReset();
  mocks.confirmDialog.mockReset().mockResolvedValue(true);
});

describe("KeyboardSettings", () => {
  it("offers Reset only for changed shortcuts", () => {
    mocks.state.shortcuts = { ...defaults(), openSearch: "Mod+Shift+K" };
    render(h(KeyboardSettings, { active: true }));

    expect(
      screen.getByRole("button", { name: "Reset Open search" })
    ).toBeTruthy();
    // Unchanged ones keep an invisible, disabled slot.
    const unchanged = screen.getByLabelText("Reset Save changes", {
      selector: "button",
    }) as HTMLButtonElement;
    expect(unchanged.disabled).toBe(true);
    expect(unchanged.className).toContain("invisible");
  });

  it("explains the rules only while recording", () => {
    render(h(KeyboardSettings, { active: true }));
    expect(screen.queryByText(/Esc stops recording/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Change shortcut for Open search, currently/,
      })
    );
    expect(screen.getByText(/Esc stops recording/)).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Recording a shortcut for Open search",
      })
    ).toBeTruthy();
  });

  it("refuses the Settings shortcut while recording", () => {
    mocks.state.setShortcut.mockReset();
    render(h(KeyboardSettings, { active: true }));
    fireEvent.click(
      screen.getByRole("button", {
        name: /Change shortcut for Close current tab/,
      })
    );

    // Ctrl+, off macOS, Cmd+, on macOS: both are Mod+, here.
    const isMac = navigator.platform.toLowerCase().includes("mac");
    fireEvent.keyDown(window, { key: ",", ctrlKey: !isMac, metaKey: isMac });

    expect(mocks.state.setShortcut).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "opens Settings and cannot be used here"
    );
  });

  it("disables Reset all with nothing to reset", () => {
    render(h(KeyboardSettings, { active: true }));
    const resetAll = screen.getByRole("button", {
      name: "Reset all",
    }) as HTMLButtonElement;
    expect(resetAll.disabled).toBe(true);
  });

  it("asks before resetting all changed shortcuts", async () => {
    mocks.state.shortcuts = { ...defaults(), openSearch: "Mod+Shift+K" };
    render(h(KeyboardSettings, { active: true }));

    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    await vi.waitFor(() => expect(mocks.state.resetAll).toHaveBeenCalled());
    expect(mocks.confirmDialog).toHaveBeenCalledWith(
      "Reset 1 changed shortcut to the defaults?",
      expect.objectContaining({ title: "Reset shortcuts" })
    );
  });

  it("does not reset when the confirmation is cancelled", async () => {
    mocks.confirmDialog.mockResolvedValue(false);
    mocks.state.shortcuts = { ...defaults(), openSearch: "Mod+Shift+K" };
    render(h(KeyboardSettings, { active: true }));

    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    await vi.waitFor(() => expect(mocks.confirmDialog).toHaveBeenCalled());
    expect(mocks.state.resetAll).not.toHaveBeenCalled();
  });
});
