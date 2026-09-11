import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  SchemaCanvasTable,
  type SchemaCanvasColumn,
} from "./SchemaCanvasTable";

type Row = { name: string; type: string };
const rows: Row[] = [
  { name: "zebra", type: "text" },
  { name: "hidden", type: "text" },
  { name: "alpha", type: "integer" },
];
const columns: SchemaCanvasColumn<Row>[] = [
  { key: "name" },
  {
    key: "type",
    options: [
      { label: "TEXT", value: "text" },
      { label: "INTEGER", value: "integer" },
    ],
  },
];
const scroller = () => document.querySelector(".overflow-auto")!;
const root = () => document.querySelector(".table-focus-root")!;
const select = (row: number, extra = {}) =>
  fireEvent.mouseDown(scroller(), {
    clientX: 80,
    clientY: 40 + row * 28,
    ...extra,
  });
const edit = (row = 0) => {
  fireEvent.dblClick(scroller(), { clientX: 80, clientY: 40 + row * 28 });
  return screen.getByPlaceholderText("NULL");
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("schema canvas editing", () => {
  it("commits edits to the original row after filtering", () => {
    const onChange = vi.fn();
    render(
      <SchemaCanvasTable
        rows={rows}
        columns={columns}
        searchQuery="alpha"
        onChange={onChange}
      />
    );
    fireEvent.input(edit(), { target: { value: "renamed" } });
    fireEvent.blur(screen.getByPlaceholderText("NULL"));
    expect(onChange).toHaveBeenCalledWith(2, "name", "renamed");
  });

  it("commits edits to the original row after sorting", () => {
    const onChange = vi.fn();
    render(
      <SchemaCanvasTable rows={rows} columns={columns} onChange={onChange} />
    );
    fireEvent.mouseUp(screen.getByText("name"), { button: 0 });
    fireEvent.mouseUp(screen.getByText("name"), { button: 0 });
    const input = edit();
    expect(input).toHaveValue("alpha");
    fireEvent.input(input, { target: { value: "renamed" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(2, "name", "renamed");
    expect(screen.queryByPlaceholderText("NULL")).toBeNull();
  });

  it("commits dropdown strings without boolean coercion", () => {
    const onChange = vi.fn();
    render(
      <SchemaCanvasTable rows={rows} columns={columns} onChange={onChange} />
    );
    fireEvent.mouseDown(scroller(), { clientX: 445, clientY: 40 });
    fireEvent.click(screen.getByRole("button", { name: "INTEGER" }));
    expect(onChange).toHaveBeenCalledWith(0, "type", "integer");
  });

  it("does not commit untouched cells or Escape", () => {
    const onChange = vi.fn();
    render(
      <SchemaCanvasTable rows={rows} columns={columns} onChange={onChange} />
    );
    fireEvent.blur(edit());
    const input = edit();
    fireEvent.input(input, { target: { value: "discard" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("deletes source indices descending after sort and multi-selection", () => {
    const onDelete = vi.fn();
    render(
      <SchemaCanvasTable
        rows={rows}
        columns={columns}
        onChange={vi.fn()}
        onDelete={onDelete}
      />
    );
    fireEvent.mouseUp(screen.getByText("name"), { button: 0 });
    fireEvent.mouseUp(screen.getByText("name"), { button: 0 });
    select(0);
    select(2, { ctrlKey: true });
    fireEvent.keyDown(root(), { key: "Delete" });
    expect(onDelete.mock.calls).toEqual([[2], [0]]);
  });

  it("select-all and range selection only delete visible rows", () => {
    const onDelete = vi.fn();
    render(
      <SchemaCanvasTable
        rows={rows}
        columns={columns}
        searchQuery="a"
        onChange={vi.fn()}
        onDelete={onDelete}
      />
    );
    select(0);
    select(1, { shiftKey: true });
    fireEvent.keyDown(root(), { key: "Backspace" });
    expect(onDelete.mock.calls).toEqual([[2], [0]]);
    onDelete.mockClear();
    fireEvent.keyDown(root(), { key: "a", ctrlKey: true });
    fireEvent.keyDown(root(), { key: "Delete" });
    expect(onDelete.mock.calls).toEqual([[2], [0]]);
  });

  it("opens foreign-key actions without a text editor", () => {
    const action = vi.fn();
    render(
      <SchemaCanvasTable
        rows={rows}
        columns={[{ key: "name", action }]}
        onChange={vi.fn()}
      />
    );
    fireEvent.dblClick(scroller(), { clientX: 80, clientY: 40 });
    expect(action).toHaveBeenCalledWith(0);
    expect(screen.queryByPlaceholderText("NULL")).toBeNull();
  });

  it("prevents mutations when locked or deleted", () => {
    const onChange = vi.fn();
    const onDelete = vi.fn();
    const onAdd = vi.fn();
    const props = { rows, columns, onChange, onDelete, onAdd };
    const view = render(<SchemaCanvasTable {...props} readOnly />);
    select(0);
    fireEvent.keyDown(root(), { key: "Delete" });
    fireEvent.dblClick(scroller(), { clientX: 80, clientY: 40 });
    fireEvent.dblClick(scroller(), { clientX: 80, clientY: 160 });
    expect(screen.queryByPlaceholderText("NULL")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onAdd).not.toHaveBeenCalled();
    view.rerender(<SchemaCanvasTable {...props} deletedRows={new Set([0])} />);
    fireEvent.dblClick(scroller(), { clientX: 80, clientY: 40 });
    fireEvent.mouseDown(scroller(), { clientX: 445, clientY: 40 });
    expect(screen.queryByPlaceholderText("NULL")).toBeNull();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("adds from blank space only when unfiltered", () => {
    const onAdd = vi.fn();
    const props = { rows, columns, onChange: vi.fn(), onAdd };
    const view = render(<SchemaCanvasTable {...props} />);
    fireEvent.dblClick(scroller(), { clientX: 80, clientY: 160 });
    expect(onAdd).toHaveBeenCalledTimes(1);
    view.rerender(<SchemaCanvasTable {...props} searchQuery="missing" />);
    fireEvent.dblClick(scroller(), { clientX: 80, clientY: 160 });
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("navigates then edits with keyboard", async () => {
    render(
      <SchemaCanvasTable rows={rows} columns={columns} onChange={vi.fn()} />
    );
    select(0);
    fireEvent.keyDown(root(), { key: "ArrowDown" });
    fireEvent.keyDown(root(), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByPlaceholderText("NULL")).toHaveValue("hidden")
    );
    fireEvent.keyDown(screen.getByPlaceholderText("NULL"), { key: "Escape" });
    await waitFor(() => expect(root()).toHaveFocus());
  });

  it("closes an editor when the table becomes read-only", () => {
    const onChange = vi.fn();
    const view = render(
      <SchemaCanvasTable rows={rows} columns={columns} onChange={onChange} />
    );
    fireEvent.input(edit(), { target: { value: "pending" } });
    view.rerender(
      <SchemaCanvasTable
        rows={rows}
        columns={columns}
        onChange={onChange}
        readOnly
      />
    );
    expect(screen.queryByPlaceholderText("NULL")).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });
});
