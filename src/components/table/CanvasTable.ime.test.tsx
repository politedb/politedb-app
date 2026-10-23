import { fireEvent, render } from "@testing-library/preact";
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

const columns = [{ name: "name", db_type: "text" }] as any;

function renderEditing(onCommitEdit = vi.fn(), onExitEdit = vi.fn()) {
  const view = render(
    <CanvasTable
      columns={columns}
      totalRows={1}
      getRowAt={() => ["Hà"]}
      widthByName={{ name: 140 }}
      emptyColumnWidth={0}
      dataVersion={0}
      selected={{ rowIdx: 0, colIdx: 0 }}
      editing={{ rowIdx: 0, colIdx: 0 }}
      onCommitEdit={onCommitEdit}
      onExitEdit={onExitEdit}
    />
  );
  return { ...view, onCommitEdit, onExitEdit };
}

describe("CanvasTable cell editor with an input method", () => {
  it("does not save or close on the Enter or Escape that ends a composition", () => {
    const { container, onCommitEdit, onExitEdit } = renderEditing();
    const input = container.querySelector("input") as HTMLInputElement;
    expect(input).toBeTruthy();
    fireEvent.input(input, { target: { value: "Hà Nội" } });

    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Escape", keyCode: 229 });
    expect(onCommitEdit).not.toHaveBeenCalled();
    expect(onExitEdit).not.toHaveBeenCalled();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onCommitEdit).toHaveBeenCalledWith(
      { rowIdx: 0, colIdx: 0 },
      "Hà Nội"
    );
  });
});
