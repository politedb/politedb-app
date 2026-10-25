import { render } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

const canvasProps = vi.hoisted(() => [] as Record<string, unknown>[]);
vi.mock("./CanvasTable", () => ({
  CanvasTable: (props: Record<string, unknown>) => {
    canvasProps.push(props);
    return null;
  },
}));

import { TableData } from "./TableData";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);

const common = {
  columns: [{ name: "id", db_type: "int" }] as any,
  baseRows: 1,
  totalRows: 1,
  getRowAt: () => [1],
  rowsVersion: 0,
};

describe("TableData read-only", () => {
  it("gives the grid no way to commit edits", () => {
    render(<TableData {...common} readOnly onCellChange={vi.fn()} />);
    const props = canvasProps[canvasProps.length - 1]!;
    expect(props.onCommitEdit).toBeUndefined();
    expect(props.onAddRow).toBeUndefined();
    expect(props.onPasteRows).toBeUndefined();
  });

  it("keeps commits for an editable grid", () => {
    render(<TableData {...common} onCellChange={vi.fn()} />);
    expect(typeof canvasProps[canvasProps.length - 1]!.onCommitEdit).toBe(
      "function"
    );
  });
});
