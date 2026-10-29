import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDumpJobStore } from "src/stores/dumpJob";
import { useScreenStore } from "src/stores/screen";

/**
 * With the real connection shortcut hook: a Shift-only binding (allowed in
 * Keyboard Settings) pressed in the progress modal does not run its action
 * behind it.
 */

vi.mock("src/stores/keyboardShortcuts", async (importActual) => {
  const actual =
    await importActual<typeof import("src/stores/keyboardShortcuts")>();
  const shortcuts = {
    ...Object.fromEntries(
      actual.SHORTCUT_DEFINITIONS.map((d) => [d.id, d.defaultBinding])
    ),
    refresh: "Shift+R",
    // A Tab chord too (Keyboard Settings accepts it).
    openSql: "Shift+Tab",
  };
  return {
    ...actual,
    useKeyboardShortcutsStore: (select: (s: unknown) => unknown) =>
      select({ shortcuts }),
  };
});
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { useConnectionShortcuts } from "src/screens/connection/hooks/useConnectionShortcuts";
import { startDumpJob } from "src/screens/connection/lib/dump/dumpJobController";
import { DumpProgressDialog } from "./DumpProgressDialog";

beforeEach(() => {
  useDumpJobStore.setState({ active: null, summary: null, closing: [] });
  useScreenStore.setState({
    profileTabs: [
      { id: "t1", profileId: "p1", runtimeConnectionId: "c1" },
    ] as never,
  });
});

describe("the progress modal and the app's shortcuts", () => {
  it("keeps Shift-only and Tab-chord shortcuts from acting behind it", () => {
    const refresh = vi.fn();
    const openSql = vi.fn();
    renderHook(() =>
      useConnectionShortcuts({
        activeWindowId: null,
        activeProfileScreen: "t1",
        actions: {
          openSql,
          beforeSaveChanges: vi.fn(),
          saveChanges: vi.fn(),
          refresh,
          closeWindow: vi.fn(),
          closeTab: vi.fn(),
        },
      })
    );
    // Without the modal the binding works.
    fireEvent.keyDown(document.body, { key: "R", shiftKey: true });
    fireEvent.keyDown(document.body, { key: "Tab", shiftKey: true });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(openSql).toHaveBeenCalledTimes(1);

    const started = startDumpJob("restore", {
      tabId: "t1",
      runtimeConnectionId: "c1",
      engine: "postgres",
      target: "shop",
    });
    if (!started.ok) throw new Error(started.message);
    render(<DumpProgressDialog />);
    act(() => {
      started.job.showProgress();
      started.job.setPhase("running", true);
    });
    const cancel = screen.getByRole("button", { name: "Cancel" });
    fireEvent.keyDown(cancel, { key: "R", shiftKey: true });
    // Shift+Tab: the modal moves focus (wrapping), nothing runs behind it.
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(cancel);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(openSql).toHaveBeenCalledTimes(1);
  });
});
