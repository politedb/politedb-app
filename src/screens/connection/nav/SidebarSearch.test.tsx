import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { SidebarSearch } from "./SidebarSearch";

function renderSearch(value: string) {
  const onChange = vi.fn();
  render(
    <SidebarSearch
      value={value}
      onChange={onChange}
      placeholder="Search tables…"
      label="Search tables"
    />
  );
  return onChange;
}

describe("SidebarSearch", () => {
  it("clears with the clear button", () => {
    const onChange = renderSearch("users");
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(onChange).toHaveBeenCalledWith("");
  });

  it("clears with Escape without letting it close anything else", () => {
    const onChange = renderSearch("users");
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search tables" }), {
      key: "Escape",
    });
    document.removeEventListener("keydown", outer);
    expect(onChange).toHaveBeenCalledWith("");
    expect(outer).not.toHaveBeenCalled();
  });

  it("has no clear button and lets Escape through while empty", () => {
    const onChange = renderSearch("");
    expect(screen.queryByRole("button", { name: "Clear search" })).toBeNull();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search tables" }), {
      key: "Escape",
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reports typing", () => {
    const onChange = renderSearch("");
    fireEvent.input(screen.getByRole("textbox", { name: "Search tables" }), {
      target: { value: "ord" },
    });
    expect(onChange).toHaveBeenCalledWith("ord");
  });
});
