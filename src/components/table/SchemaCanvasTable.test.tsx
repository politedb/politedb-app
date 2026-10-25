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
    // One click sorts ascending.
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
    fireEvent.click(screen.getByRole("menuitem", { name: "INTEGER" }));
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

  it("shows column labels in the header, keys when unlabeled", () => {
    render(
      <SchemaCanvasTable
        rows={rows}
        columns={[{ key: "name", label: "Name" }, { key: "type" }]}
        onChange={() => {}}
      />
    );
    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.textContent?.trim());
    expect(headers).toContain("Name");
    expect(headers).toContain("type");
    expect(headers).not.toContain("name");
  });

  it("shows the empty message only without rows", () => {
    const view = render(
      <SchemaCanvasTable
        rows={[] as Row[]}
        columns={columns}
        onChange={() => {}}
        emptyMessage="No columns yet."
      />
    );
    expect(screen.getByRole("status").textContent).toBe("No columns yet.");
    view.rerender(
      <SchemaCanvasTable
        rows={rows}
        columns={columns}
        onChange={() => {}}
        emptyMessage="No columns yet."
      />
    );
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("adds and removes columns of a multi-value cell", () => {
    type IndexRow = { name: string; cols: string };
    const indexColumns: SchemaCanvasColumn<IndexRow>[] = [
      { key: "name" },
      {
        key: "cols",
        multiple: true,
        options: [
          { label: "last_name", value: "last_name" },
          { label: "first_name", value: "first_name" },
        ],
      },
    ];
    const onChange = vi.fn();
    render(
      <SchemaCanvasTable
        rows={[{ name: "people_idx", cols: "last_name" }]}
        columns={indexColumns}
        onChange={onChange}
      />
    );
    const openMenu = () =>
      fireEvent.mouseDown(scroller(), { clientX: 445, clientY: 40 });

    openMenu();
    // The state is announced, not only drawn.
    const last = screen.getByRole("menuitemcheckbox", { name: "last_name" });
    const first = screen.getByRole("menuitemcheckbox", { name: "first_name" });
    expect(last.getAttribute("aria-checked")).toBe("true");
    expect(first.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(first);
    expect(onChange).toHaveBeenLastCalledWith(
      0,
      "cols",
      "last_name,first_name"
    );

    openMenu();
    fireEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "last_name" })
    );
    expect(onChange).toHaveBeenLastCalledWith(0, "cols", "");
  });

  it("draws the option control on an empty option cell", () => {
    const fills: number[] = [];
    const ctx = new Proxy(
      {},
      {
        get: (_target, key) => {
          if (key === "measureText") return () => ({ width: 5 });
          if (key === "fill") return () => fills.push(1);
          return () => {};
        },
        set: () => true,
      }
    );
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
      ctx as never
    );
    // jsdom lays nothing out: give the grid a viewport to draw into.
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400);
    render(
      <SchemaCanvasTable
        rows={[{ name: "a", type: "" }]}
        columns={columns}
        onChange={() => {}}
      />
    );
    // Two triangles (up and down) for the empty "type" cell.
    expect(fills.length).toBeGreaterThanOrEqual(2);
  });
});
