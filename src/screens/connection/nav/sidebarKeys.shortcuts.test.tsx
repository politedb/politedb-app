import { fireEvent, render, renderHook, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

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

import { useConnectionShortcuts } from "../hooks/useConnectionShortcuts";
import { ContextMenu } from "src/components/common/ContextMenu";
import { handleSidebarListKeyDown } from "./sidebarListKeys";
import { SidebarSectionHeader } from "./SidebarSectionHeader";

function withShortcuts() {
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

describe("sidebar and menu keys with app shortcuts", () => {
  it("a snippet chord on a sidebar row runs the snippet without moving focus", () => {
    const insert = withShortcuts();
    render(
      <div onKeyDown={handleSidebarListKeyDown}>
        <button data-sidebar-item>users</button>
        <button data-sidebar-item>orders</button>
      </div>
    );
    const users = screen.getByRole("button", { name: "users" });
    users.focus();
    for (const key of ["ArrowDown", "End"]) {
      fireEvent.keyDown(users, { key, altKey: true });
    }
    expect(document.activeElement).toBe(users);
    expect(insert).toHaveBeenCalledTimes(2);

    // Plain keys still navigate.
    fireEvent.keyDown(users, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "orders" })
    );
  });

  it("a chord on a section header does not toggle it", () => {
    withShortcuts();
    const onToggle = vi.fn();
    render(
      <SidebarSectionHeader
        title="Tables"
        expanded={false}
        onToggle={onToggle}
      />
    );
    fireEvent.keyDown(screen.getByRole("button", { name: /Tables/ }), {
      key: "ArrowRight",
      altKey: true,
    });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it("a chord in a menu runs the shortcut without moving focus", () => {
    const insert = withShortcuts();
    render(
      <ContextMenu
        autoFocus
        open
        x={0}
        y={0}
        onClose={() => {}}
        items={[
          { type: "item", label: "Open data" },
          { type: "item", label: "Copy name" },
        ]}
      />
    );
    const first = screen.getByRole("menuitem", { name: "Open data" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown", altKey: true });
    expect(document.activeElement).toBe(first);
    expect(insert).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Copy name" })
    );
  });
});
