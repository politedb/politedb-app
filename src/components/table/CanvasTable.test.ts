import { h } from "preact";
import { useState } from "preact/hooks";
import { fireEvent, render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasTable, getCanvasRowBackground } from "./CanvasTable";

class ResizeObserverMock {
  observe() {}
  disconnect() {}
}

function CanvasTableHarness({
  onCommitEdit,
}: {
  onCommitEdit: (
    cell: { rowIdx: number; colIdx: number },
    value: unknown
  ) => void;
}) {
  const [editing, setEditing] = useState<{
    rowIdx: number;
    colIdx: number;
  } | null>(null);

  return h(
    "div",
    { style: { width: "400px", height: "200px" } },
    h(CanvasTable, {
      columns: [{ name: "name", db_type: "text" }],
      totalRows: 1,
      getRowAt: () => [null],
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
});

describe("CanvasTable cell editor", () => {
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
