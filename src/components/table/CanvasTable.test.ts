import { h } from "preact";
import { useState } from "preact/hooks";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isDefaultCellEditValue } from "src/lib/table-data/cellEditValue";
import { CanvasTable, getCanvasRowBackground } from "./CanvasTable";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

function CanvasTableHarness({
  onCommitEdit,
  cellValue = null,
  dbType = "text",
  columnDefault,
}: {
  onCommitEdit: (
    cell: { rowIdx: number; colIdx: number },
    value: unknown
  ) => void;
  cellValue?: unknown;
  dbType?: string;
  columnDefault?: string | null;
}) {
  const [editing, setEditing] = useState<{
    rowIdx: number;
    colIdx: number;
  } | null>(null);

  return h(
    "div",
    { style: { width: "400px", height: "200px" } },
    h(CanvasTable, {
      columns: [
        { name: "name", db_type: dbType, column_default: columnDefault },
      ],
      totalRows: 1,
      getRowAt: () => [cellValue],
      widthByName: { name: 140 },
      emptyColumnWidth: 0,
      dataVersion: 0,
      editing,
      onStartEdit: setEditing,
      onExitEdit: () => setEditing(null),
      onCommitEdit,
    })
  );
}

function openNullCellEditor() {
  const scroller = document.querySelector(".overflow-auto");
  if (!scroller) throw new Error("Canvas scroller not found");
  fireEvent.dblClick(scroller, { clientX: 20, clientY: 40 });
  return screen.getByPlaceholderText("NULL");
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("getCanvasRowBackground", () => {
  it("keeps a selected new row green", () => {
    expect(getCanvasRowBackground(true, true, true)).toBe("#dcfce7");
    expect(getCanvasRowBackground(true, true, false)).toBe("#dcfce7");
  });

  it("preserves existing selected row colors", () => {
    expect(getCanvasRowBackground(false, true, true)).toBe("#bedbff");
    expect(getCanvasRowBackground(false, true, false)).toBe("#dbdbdb");
    expect(getCanvasRowBackground(false, false, true)).toBeNull();
  });

  it("uses dark canvas colors when theme is dark", () => {
    expect(getCanvasRowBackground(false, true, true, "dark")).toBe("#264f78");
    expect(getCanvasRowBackground(true, false, false, "dark")).toBe("#14532d");
  });
});

describe("CanvasTable cell editor", () => {
  it("keeps the viewport canvas outside scroll content", () => {
    render(
      h(CanvasTableHarness, {
        onCommitEdit: vi.fn(),
        cellValue: "value",
      })
    );

    const scroller = document.querySelector(".overflow-auto");
    const canvas = document.querySelector("[data-canvas-table-viewport]");
    expect(scroller).not.toBeNull();
    expect(canvas).not.toBeNull();
    expect(scroller?.contains(canvas)).toBe(false);
    expect(canvas).toHaveStyle({ position: "absolute", pointerEvents: "none" });
  });

  it("opens a value menu directly from the boolean control", () => {
    const onCommitEdit = vi.fn();
    render(
      h(CanvasTableHarness, {
        onCommitEdit,
        cellValue: true,
        dbType: "boolean",
      })
    );

    const scroller = document.querySelector(".overflow-auto");
    if (!scroller) throw new Error("Canvas scroller not found");
    fireEvent.mouseDown(scroller, { clientX: 130, clientY: 40 });

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText("Set NULL")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "DEFAULT" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "FALSE" }));

    expect(onCommitEdit).toHaveBeenCalledWith({ rowIdx: 0, colIdx: 0 }, false);
  });

  it("opens boolean content as selected text on double-click", async () => {
    const onCommitEdit = vi.fn();
    render(
      h(CanvasTableHarness, {
        onCommitEdit,
        cellValue: true,
        dbType: "boolean",
      })
    );

    const editor = openNullCellEditor() as HTMLInputElement;
    await waitFor(() => {
      expect(editor).toHaveFocus();
      expect(editor.selectionStart).toBe(0);
      expect(editor.selectionEnd).toBe("true".length);
    });

    fireEvent.input(editor, { target: { value: "false" } });
    fireEvent.blur(editor);
    expect(onCommitEdit).toHaveBeenCalledWith({ rowIdx: 0, colIdx: 0 }, false);
  });

  it("offers DEFAULT only when the boolean column has a default", () => {
    const onCommitEdit = vi.fn();
    render(
      h(CanvasTableHarness, {
        onCommitEdit,
        cellValue: false,
        dbType: "boolean",
        columnDefault: "true",
      })
    );

    const scroller = document.querySelector(".overflow-auto");
    if (!scroller) throw new Error("Canvas scroller not found");
    fireEvent.mouseDown(scroller, { clientX: 130, clientY: 40 });
    fireEvent.click(screen.getByRole("button", { name: "DEFAULT" }));

    const value = onCommitEdit.mock.calls[0]?.[1];
    expect(isDefaultCellEditValue(value)).toBe(true);
  });

  it("selects all text when double-click opens an editor", async () => {
    render(
      h(CanvasTableHarness, {
        onCommitEdit: vi.fn(),
        cellValue: "hello world",
      })
    );

    const editor = openNullCellEditor() as HTMLInputElement;
    await waitFor(() => {
      expect(editor).toHaveFocus();
      expect(editor.selectionStart).toBe(0);
      expect(editor.selectionEnd).toBe("hello world".length);
    });
  });

  it("does not mark an untouched NULL cell as changed on blur", () => {
    const onCommitEdit = vi.fn();
    render(h(CanvasTableHarness, { onCommitEdit }));

    const editor = openNullCellEditor();
    expect(editor).toHaveValue("");
    fireEvent.blur(editor);

    expect(onCommitEdit).not.toHaveBeenCalled();
  });

  it("still commits an intentional change from NULL", () => {
    const onCommitEdit = vi.fn();
    render(h(CanvasTableHarness, { onCommitEdit }));

    const editor = openNullCellEditor();
    fireEvent.input(editor, { target: { value: "updated" } });
    fireEvent.blur(editor);

    expect(onCommitEdit).toHaveBeenCalledWith(
      { rowIdx: 0, colIdx: 0 },
      "updated"
    );
  });

  it("commits EMPTY when user intentionally edits a NULL cell to empty", () => {
    const onCommitEdit = vi.fn();
    render(h(CanvasTableHarness, { onCommitEdit }));

    const editor = openNullCellEditor();
    fireEvent.input(editor, { target: { value: "" } });
    fireEvent.blur(editor);

    expect(onCommitEdit).toHaveBeenCalledWith({ rowIdx: 0, colIdx: 0 }, "");
  });
});

describe("CanvasTable column resize", () => {
  it("commits live width at most once per animation frame without a guide", () => {
    const rafCallbacks: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return rafCallbacks.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());

    render(h(CanvasTableHarness, { onCommitEdit: vi.fn() }));

    const handle = document.querySelector<HTMLElement>("[data-resize-handle]");
    const header = handle?.parentElement;
    if (!handle || !header) throw new Error("Resize handle not found");

    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();

    fireEvent.pointerDown(handle, { clientX: 140, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 200, pointerId: 1 });

    expect(header.style.width).toBe("140px");
    act(() => rafCallbacks.shift()?.(0));

    expect(document.querySelector("[aria-hidden='true']")).toBeNull();
    expect(header.style.width).toBe("200px");

    fireEvent.pointerMove(window, { clientX: 220, pointerId: 1 });
    fireEvent.pointerMove(window, { clientX: 240, pointerId: 1 });

    expect(rafCallbacks).toHaveLength(1);
    act(() => rafCallbacks.shift()?.(16));
    expect(header.style.width).toBe("200px");

    fireEvent.pointerMove(window, { clientX: 260, pointerId: 1 });
    act(() => rafCallbacks.shift()?.(32));
    expect(header.style.width).toBe("260px");

    fireEvent.pointerMove(window, { clientX: 270, pointerId: 1 });
    fireEvent.pointerUp(window, { clientX: 270, pointerId: 1 });

    expect(header.style.width).toBe("270px");
  });
});
