import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";

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

import { useConnectionShortcuts } from "src/screens/connection/hooks/useConnectionShortcuts";
import {
  confirmExplainAnalyze,
  useExplainAnalyzeConfirmStore,
} from "src/stores/explainAnalyzeConfirm";
import { ExplainAnalyzeConfirmHost } from "./ExplainAnalyzeConfirmHost";

function workspace() {
  const actions = {
    openSql: vi.fn(),
    beforeSaveChanges: vi.fn(),
    saveChanges: vi.fn(),
    refresh: vi.fn(),
    closeWindow: vi.fn(),
    closeTab: vi.fn(),
  };
  renderHook(() =>
    useConnectionShortcuts({
      activeWindowId: "w1",
      activeProfileScreen: "tab-1",
      actions,
    })
  );
  return actions;
}

/** Mod+key, sent both ways so it matches on every platform. */
function pressMod(target: Element, key: string) {
  fireEvent.keyDown(target, { key, ctrlKey: true });
  fireEvent.keyDown(target, { key, metaKey: true });
}

function ask() {
  let result!: Promise<boolean>;
  act(() => {
    result = confirmExplainAnalyze({
      target: "Local PG",
      statement: "select 1",
    });
  });
  return result;
}

afterEach(() => {
  useExplainAnalyzeConfirmStore.getState().answer(false);
});

describe("Explain Analyze confirmation keyboard isolation", () => {
  it("keeps workspace shortcuts from running while open", () => {
    const actions = workspace();
    const editor = document.createElement("div");
    editor.tabIndex = 0;
    document.body.appendChild(editor);

    // Control: without the dialog the shortcuts work.
    pressMod(editor, "s");
    expect(actions.beforeSaveChanges).toHaveBeenCalled();
    actions.beforeSaveChanges.mockClear();

    render(<ExplainAnalyzeConfirmHost />);
    void ask();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    for (const key of ["s", "w", "t", "r"]) pressMod(cancel, key);
    expect(actions.beforeSaveChanges).not.toHaveBeenCalled();
    expect(actions.closeWindow).not.toHaveBeenCalled();
    expect(actions.openSql).not.toHaveBeenCalled();
    expect(actions.refresh).not.toHaveBeenCalled();
    editor.remove();
  });

  it("keeps Tab and Shift+Tab on its two buttons", () => {
    render(<ExplainAnalyzeConfirmHost />);
    void ask();
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const run = screen.getByRole("button", { name: "Run Explain Analyze" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab" });
    expect(document.activeElement).toBe(run);
    fireEvent.keyDown(run, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(run);
  });

  it("Enter with focus outside the buttons goes back to Cancel", () => {
    render(<ExplainAnalyzeConfirmHost />);
    void ask();
    (document.activeElement as HTMLElement).blur();
    fireEvent.keyDown(document.body, { key: "Enter" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" })
    );
  });

  it("returns focus to where it was when closed", async () => {
    const editor = document.createElement("button");
    document.body.appendChild(editor);
    editor.focus();
    render(<ExplainAnalyzeConfirmHost />);
    const result = ask();
    act(() => {
      fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    });
    await expect(result).resolves.toBe(false);
    expect(document.activeElement).toBe(editor);
    editor.remove();
  });
});
