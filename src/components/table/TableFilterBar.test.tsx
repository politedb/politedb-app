import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { TableFilterBar } from "./TableFilterBar";

function renderBar(overrides: Record<string, unknown> = {}) {
  const props = {
    tableKey: "t",
    schema: "public",
    tableName: "cities",
    engine: "postgres",
    columns: [{ name: "name", db_type: "text" }],
    filters: [
      { id: 0, column: "name", operator: "=", value: "a", enabled: true },
      { id: 2, column: "name", operator: "=", value: "b", enabled: true },
    ],
    filterCombine: "OR",
    appliedFilters: [],
    limit: 100,
    offset: 0,
    onFiltersChange: vi.fn(),
    onFilterCombineChange: vi.fn(),
    onApply: vi.fn(),
    onClear: vi.fn(),
    setFilterVisible: vi.fn(),
    ...overrides,
  } as any;
  render(<TableFilterBar {...props} />);
  return props;
}

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

describe("TableFilterBar controls", () => {
  it("gives a new condition an id no draft or applied condition uses", () => {
    const props = renderBar();
    fireEvent.click(screen.getAllByRole("button", { name: "Add filter" })[0]!);
    const next = props.onFiltersChange.mock.calls[0][0];
    expect(next.map((f: { id: number }) => f.id)).toEqual([0, 2, 3]);
  });

  it("does not reuse the id of a removed condition that is still applied", () => {
    // Condition 2 was applied, then its draft row removed.
    const applied = {
      id: 2,
      column: "name",
      operator: "=",
      value: "b",
      enabled: true,
    };
    const props = renderBar({
      filters: [
        { id: 0, column: "name", operator: "=", value: "a", enabled: true },
        { id: 1, column: "name", operator: "=", value: "c", enabled: true },
      ],
      appliedFilters: [applied],
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Add filter" })[0]!);
    const added = props.onFiltersChange.mock.calls[0][0].at(-1);
    expect(added.id).toBe(3);
    // The new draft is not shown as applied.
    expect(
      screen.queryByRole("textbox", { name: "Value (applied)" })
    ).toBeNull();
  });

  it("labels each control of a condition", () => {
    renderBar();
    expect(
      screen.getAllByRole("checkbox", { name: "Use this condition" })
    ).toHaveLength(2);
    expect(screen.getAllByRole("combobox", { name: "Column" })).toHaveLength(2);
    expect(screen.getAllByRole("combobox", { name: "Operator" })).toHaveLength(
      2
    );
    expect(screen.getAllByRole("textbox", { name: "Value" })).toHaveLength(2);
  });

  it("marks applied conditions in words, not only by color", () => {
    renderBar({
      appliedFilters: [
        { id: 2, column: "name", operator: "=", value: "b", enabled: true },
      ],
    });
    expect(
      screen.getByRole("textbox", { name: "Value (applied)" })
    ).toHaveValue("b");
  });

  it("applies all with the current join, or the one picked from the menu", () => {
    const props = renderBar();
    fireEvent.click(screen.getByRole("button", { name: "Apply All (OR)" }));
    expect(props.onApply).toHaveBeenLastCalledWith(props.filters, "OR", "t");

    fireEvent.click(
      screen.getByRole("button", { name: "Choose how to join conditions" })
    );
    fireEvent.click(
      screen.getByRole("menuitemradio", { name: /AND: rows matching all/ })
    );
    expect(props.onFilterCombineChange).toHaveBeenCalledWith("AND");
    expect(props.onApply).toHaveBeenLastCalledWith(props.filters, "AND", "t");
  });

  it("hides the bar on Escape, closing the join menu first", () => {
    const props = renderBar();
    fireEvent.click(
      screen.getByRole("button", { name: "Choose how to join conditions" })
    );
    const value = screen.getAllByRole("textbox", { name: "Value" })[0]!;
    fireEvent.keyDown(value, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(props.setFilterVisible).not.toHaveBeenCalled();

    fireEvent.keyDown(value, { key: "Escape" });
    expect(props.setFilterVisible).toHaveBeenCalledWith(false, "t");
  });
});
