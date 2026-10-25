import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { ContextMenu, type MenuItem } from "./ContextMenu";

const items = (onCsv = vi.fn()): MenuItem[] => [
  { type: "item", label: "Open data" },
  { type: "item", label: "Disabled", disabled: true },
  { type: "sep" },
  {
    type: "item",
    label: "Import",
    submenu: [
      { type: "item", label: "From CSV...", onClick: onCsv },
      { type: "item", label: "From SQL Dump..." },
    ],
  },
  { type: "item", label: "Drop...", color: "red" },
];

const item = (name: string) =>
  screen.getByRole("menuitem", {
    name: new RegExp(`^${name.replace(/\./g, "\\.")}`),
  });

describe("ContextMenu keyboard", () => {
  it("focuses the first item and moves over enabled items", () => {
    render(
      <ContextMenu
        autoFocus
        open
        x={0}
        y={0}
        items={items()}
        onClose={() => {}}
      />
    );
    expect(document.activeElement).toBe(item("Open data"));
    fireEvent.keyDown(item("Open data"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Import"));
    fireEvent.keyDown(item("Import"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Drop..."));
    fireEvent.keyDown(item("Drop..."), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("Open data"));
    fireEvent.keyDown(item("Open data"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(item("Drop..."));
    fireEvent.keyDown(item("Drop..."), { key: "Home" });
    expect(document.activeElement).toBe(item("Open data"));
  });

  it("enters and leaves a submenu with Right and Left", async () => {
    const onCsv = vi.fn();
    render(
      <ContextMenu
        autoFocus
        open
        x={0}
        y={0}
        items={items(onCsv)}
        onClose={() => {}}
      />
    );
    item("Import").focus();
    fireEvent.keyDown(item("Import"), { key: "ArrowRight" });
    await waitFor(() =>
      expect(document.activeElement).toBe(item("From CSV..."))
    );
    expect(item("Import").getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(item("From CSV..."), { key: "ArrowDown" });
    expect(document.activeElement).toBe(item("From SQL Dump..."));
    fireEvent.keyDown(item("From SQL Dump..."), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(item("Import"));
    expect(screen.queryByRole("menuitem", { name: "From CSV..." })).toBeNull();
  });

  it("gives focus back to what opened it when it closes", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const view = render(
      <ContextMenu
        autoFocus
        open
        x={0}
        y={0}
        items={items()}
        onClose={() => {}}
      />
    );
    expect(document.activeElement).not.toBe(opener);
    view.rerender(
      <ContextMenu
        autoFocus
        open={false}
        x={0}
        y={0}
        items={items()}
        onClose={() => {}}
      />
    );
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it("leaves focus alone unless asked to take it", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    render(<ContextMenu open x={0} y={0} items={items()} onClose={() => {}} />);
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
