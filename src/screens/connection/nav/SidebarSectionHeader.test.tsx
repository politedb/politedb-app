import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { SidebarSectionHeader } from "./SidebarSectionHeader";

describe("SidebarSectionHeader", () => {
  it("toggles from the whole row and shows the count", () => {
    const onToggle = vi.fn();
    const onOpenList = vi.fn();
    render(
      <SidebarSectionHeader
        title="Tables"
        count={42}
        expanded={false}
        onToggle={onToggle}
        onOpenList={onOpenList}
      />
    );
    const row = screen.getByRole("button", { name: /Tables/ });
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).toContain("42");
    fireEvent.click(row);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onOpenList).not.toHaveBeenCalled();
  });

  it("opens the full list from its own button without toggling", () => {
    const onToggle = vi.fn();
    const onOpenList = vi.fn();
    render(
      <SidebarSectionHeader
        title="Views"
        expanded
        onToggle={onToggle}
        onOpenList={onOpenList}
      />
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Show all views in a list" })
    );
    expect(onOpenList).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
    expect(
      screen
        .getByRole("button", { name: /^Views/ })
        .getAttribute("aria-expanded")
    ).toBe("true");
  });

  it("has no list button when there is no full list", () => {
    render(<SidebarSectionHeader title="Keys" expanded onToggle={() => {}} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("opens with Right and closes with Left, like a tree", () => {
    const onToggle = vi.fn();
    const view = render(
      <SidebarSectionHeader
        title="Tables"
        expanded={false}
        onToggle={onToggle}
      />
    );
    const row = screen.getByRole("button", { name: /Tables/ });
    fireEvent.keyDown(row, { key: "ArrowLeft" });
    expect(onToggle).not.toHaveBeenCalled();
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(onToggle).toHaveBeenCalledTimes(1);
    view.rerender(
      <SidebarSectionHeader title="Tables" expanded onToggle={onToggle} />
    );
    fireEvent.keyDown(row, { key: "ArrowRight" });
    expect(onToggle).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(row, { key: "ArrowLeft" });
    expect(onToggle).toHaveBeenCalledTimes(2);
  });
});
