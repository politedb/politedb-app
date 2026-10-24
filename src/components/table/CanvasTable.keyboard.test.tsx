import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { CanvasTable } from "./CanvasTable";

// jsdom has neither ResizeObserver nor a 2D canvas.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);
HTMLCanvasElement.prototype.getContext = (() => null) as any;

const columns = [
  { name: "id", db_type: "int" },
  { name: "name", db_type: "text" },
  { name: "city", db_type: "text" },
] as any;

function renderGrid(overrides: Record<string, unknown> = {}) {
  const props = {
    columns,
    totalRows: 50,
    getRowAt: (row: number) => [row, `name ${row}`, "Hà Nội"],
    widthByName: { id: 80, name: 140, city: 140 },
    emptyColumnWidth: 0,
    dataVersion: 0,
    selected: { rowIdx: 5, colIdx: 1 },
    selectedRows: new Set([5]),
    onSelect: vi.fn(),
    onStartEdit: vi.fn(),
    onCommitEdit: vi.fn(),
    onExitEdit: vi.fn(),
    onClearSelection: vi.fn(),
    onChangeSort: vi.fn(),
    onAddRow: vi.fn(),
    ...overrides,
  } as any;
  const view = render(<CanvasTable {...props} />);
  const root = view.container.querySelector(".table-focus-root") as HTMLElement;
  return { ...view, props, root };
}

describe("CanvasTable keyboard", () => {
  it("starts editing a selected cell with the typed character", () => {
    const { props, root } = renderGrid();
    fireEvent.keyDown(root, { key: "x" });
    expect(props.onStartEdit).toHaveBeenCalledWith({ rowIdx: 5, colIdx: 1 });
  });

  it("does not start editing on shortcuts or in a read-only list", () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const { props, root } = renderGrid();
    fireEvent.keyDown(root, { key: "c", metaKey: true });
    expect(props.onStartEdit).not.toHaveBeenCalled();

    const list = renderGrid({ onActivateRow: vi.fn() });
    fireEvent.keyDown(list.root, { key: "x" });
    expect(list.props.onStartEdit).not.toHaveBeenCalled();
  });

  it("moves with Home, End, Page keys and Cmd+Arrow", () => {
    const { props, root } = renderGrid();
    fireEvent.keyDown(root, { key: "Home" });
    fireEvent.keyDown(root, { key: "End" });
    fireEvent.keyDown(root, { key: "End", metaKey: true });
    fireEvent.keyDown(root, { key: "ArrowUp", metaKey: true });
    fireEvent.keyDown(root, { key: "PageDown" });
    expect(
      props.onSelect.mock.calls.map((c: unknown[]) => c.slice(0, 2))
    ).toEqual([
      [5, 0],
      [5, 2],
      [49, 2],
      [0, 1],
      [expect.any(Number), 1],
    ]);
    expect(props.onSelect.mock.calls[4][0]).toBeGreaterThan(5);
  });

  it("jumps to the row's first or last column with Cmd/Ctrl+Left/Right", () => {
    const { props, root } = renderGrid();
    fireEvent.keyDown(root, { key: "ArrowRight", ctrlKey: true });
    fireEvent.keyDown(root, { key: "ArrowLeft", metaKey: true });
    fireEvent.keyDown(root, {
      key: "ArrowRight",
      metaKey: true,
      shiftKey: true,
    });
    expect(props.onSelect.mock.calls).toEqual([
      [5, 2, false, false],
      [5, 0, false, false],
      [5, 2, false, true],
    ]);
  });

  it("clears the selection on Escape", () => {
    const { props, root } = renderGrid();
    fireEvent.keyDown(root, { key: "Escape" });
    expect(props.onClearSelection).toHaveBeenCalled();
  });

  it("moves down after Enter saves an edit, and across after Tab", () => {
    const { props, container } = renderGrid({
      editing: { rowIdx: 5, colIdx: 1 },
    });
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "new" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommitEdit).toHaveBeenCalledWith(
      { rowIdx: 5, colIdx: 1 },
      "new"
    );
    expect(props.onSelect).toHaveBeenLastCalledWith(6, 1, false, false);
  });

  it("wraps Tab and Shift+Tab in the editor to the adjacent row", () => {
    const last = renderGrid({ editing: { rowIdx: 5, colIdx: 2 } });
    fireEvent.keyDown(last.container.querySelector("input")!, { key: "Tab" });
    expect(last.props.onSelect).toHaveBeenLastCalledWith(6, 0, false, false);
    last.unmount();

    const first = renderGrid({ editing: { rowIdx: 5, colIdx: 0 } });
    fireEvent.keyDown(first.container.querySelector("input")!, {
      key: "Tab",
      shiftKey: true,
    });
    expect(first.props.onSelect).toHaveBeenLastCalledWith(4, 2, false, false);
    first.unmount();

    // At the grid's end there is nowhere further: stay on the last cell.
    const end = renderGrid({
      selected: { rowIdx: 49, colIdx: 2 },
      editing: { rowIdx: 49, colIdx: 2 },
    });
    fireEvent.keyDown(end.container.querySelector("input")!, { key: "Tab" });
    expect(end.props.onSelect).toHaveBeenLastCalledWith(49, 2, false, false);
  });

  it("stays in the cell when the value is refused", () => {
    const { props, container } = renderGrid({
      columns: [{ name: "flag", db_type: "boolean" }],
      widthByName: { flag: 140 },
      selected: { rowIdx: 0, colIdx: 0 },
      editing: { rowIdx: 0, colIdx: 0 },
      getRowAt: () => [true],
    });
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "maybe" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onCommitEdit).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(screen.getByText("Use true, false, 1, 0, or NULL")).toBeTruthy();
  });
});

describe("CanvasTable headers", () => {
  it("sorts ascending first, by click or keyboard, and reports it", () => {
    const { props } = renderGrid({
      sortState: { colName: "id", direction: "desc" },
    });
    const name = screen.getByRole("columnheader", { name: /name/ });
    fireEvent.mouseUp(name, { button: 0 });
    expect(props.onChangeSort).toHaveBeenLastCalledWith({
      colName: "name",
      direction: "asc",
    });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(props.onChangeSort).toHaveBeenCalledTimes(2);
    // Enter on a header never opens the selected cell's editor.
    expect(props.onStartEdit).not.toHaveBeenCalled();
    expect(screen.getByRole("columnheader", { name: /id/ })).toHaveAttribute(
      "aria-sort",
      "descending"
    );
  });
});

describe("CanvasTable blank double-click", () => {
  it("adds a row only where allowed", () => {
    const grid = renderGrid({ totalRows: 1, addRowOnBlankDoubleClick: false });
    const scroller = grid.root.firstElementChild as HTMLElement;
    fireEvent.dblClick(scroller, { clientX: 40, clientY: 300 });
    expect(grid.props.onAddRow).not.toHaveBeenCalled();
  });
});

describe("CanvasTable in a read-only grid", () => {
  it("offers no value menu or edit actions without a commit handler", () => {
    const { props, root } = renderGrid({
      onStartEdit: undefined,
      onCommitEdit: undefined,
    });
    fireEvent.keyDown(root, { key: "x" });
    fireEvent.keyDown(root, { key: "Enter" });
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(root.querySelector("input")).toBeNull();
  });
});
