import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { TableFilterBar } from "./TableFilterBar";

describe("TableFilterBar value input", () => {
  it("applies on Enter, but not on the Enter that ends an IME composition", () => {
    const onApply = vi.fn();
    const filter = {
      id: 0,
      column: "name",
      operator: "=",
      value: "Hà Nội",
      enabled: true,
    };
    render(
      <TableFilterBar
        tableKey="t"
        schema="public"
        tableName="cities"
        engine="postgres"
        columns={[{ name: "name", db_type: "text" }] as any}
        filters={[filter]}
        filterCombine="AND"
        appliedFilters={[]}
        limit={100}
        offset={0}
        onFiltersChange={vi.fn()}
        onFilterCombineChange={vi.fn()}
        onApply={onApply}
        onClear={vi.fn()}
        setFilterVisible={vi.fn()}
      />
    );
    const input = screen.getByDisplayValue("Hà Nội");
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onApply).toHaveBeenCalledWith([filter], "AND", "t");
  });
});
