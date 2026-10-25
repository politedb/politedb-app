import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { TableViewToggle } from "./TableViewToggle";

describe("TableViewToggle", () => {
  it("marks the current view and switches on click", () => {
    const onChange = vi.fn();
    render(<TableViewToggle viewMode="data" onViewModeChange={onChange} />);
    expect(screen.getByRole("group", { name: "Table view" })).toBeTruthy();
    const data = screen.getByRole("button", { name: "Data" });
    const structure = screen.getByRole("button", { name: "Structure" });
    expect(data.getAttribute("aria-pressed")).toBe("true");
    expect(structure.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(structure);
    expect(onChange).toHaveBeenCalledWith("structure");
  });
});
