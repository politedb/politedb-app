import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { handleSidebarListKeyDown } from "./sidebarListKeys";

function renderList(onContextMenu = vi.fn()) {
  render(
    <div onKeyDown={handleSidebarListKeyDown}>
      <button data-sidebar-item>Tables</button>
      <button data-sidebar-item onContextMenu={onContextMenu}>
        users
      </button>
      <button data-sidebar-item disabled>
        locked
      </button>
      <button data-sidebar-item>orders</button>
      <button>not a row</button>
    </div>
  );
  return onContextMenu;
}

const row = (name: string) => screen.getByRole("button", { name });

describe("handleSidebarListKeyDown", () => {
  it("moves between enabled rows with arrows, Home and End", () => {
    renderList();
    row("Tables").focus();
    fireEvent.keyDown(row("Tables"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("users"));
    fireEvent.keyDown(row("users"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("orders"));
    fireEvent.keyDown(row("orders"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(row("users"));
    fireEvent.keyDown(row("users"), { key: "End" });
    expect(document.activeElement).toBe(row("orders"));
    fireEvent.keyDown(row("orders"), { key: "Home" });
    expect(document.activeElement).toBe(row("Tables"));
  });

  it("stays put at the ends and ignores other elements", () => {
    renderList();
    row("orders").focus();
    fireEvent.keyDown(row("orders"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row("orders"));
    row("not a row").focus();
    fireEvent.keyDown(row("not a row"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(row("not a row"));
  });

  it("opens a row's context menu with Shift+F10 or the Menu key", () => {
    const onContextMenu = renderList();
    fireEvent.keyDown(row("users"), { key: "F10", shiftKey: true });
    fireEvent.keyDown(row("users"), { key: "ContextMenu" });
    expect(onContextMenu).toHaveBeenCalledTimes(2);
    fireEvent.keyDown(row("users"), { key: "F10" });
    expect(onContextMenu).toHaveBeenCalledTimes(2);
  });
});
