import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { SqlEditorToolbar } from "./SqlEditorToolbar";

const base = { onRun: vi.fn(), isExecuting: false, hasSelection: false };

describe("SqlEditorToolbar Explain", () => {
  it("is a single estimated Explain without Explain Analyze (Free)", () => {
    const onExplain = vi.fn();
    render(<SqlEditorToolbar {...base} onExplain={onExplain} />);
    expect(screen.queryByText(/Explain Analyze/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    expect(onExplain).toHaveBeenCalledTimes(1);
  });

  it("measures on its single Explain button (Pro)", () => {
    const onExplain = vi.fn();
    const onExplainAnalyze = vi.fn();
    render(
      <SqlEditorToolbar
        {...base}
        onExplain={onExplain}
        onExplainAnalyze={onExplainAnalyze}
      />
    );
    expect(screen.getAllByRole("button", { name: "Explain" })).toHaveLength(1);
    expect(screen.queryByText(/Estimated plan/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Explain" }));
    expect(onExplainAnalyze).toHaveBeenCalledTimes(1);
    expect(onExplain).not.toHaveBeenCalled();
  });

  it("is disabled while a statement runs", () => {
    render(
      <SqlEditorToolbar
        {...base}
        isExecuting
        onExplain={vi.fn()}
        onExplainAnalyze={vi.fn()}
      />
    );
    expect(screen.getByRole("button", { name: "Explain" })).toBeDisabled();
  });
});

describe("SqlEditorToolbar run buttons", () => {
  it("offers Run All next to Run, but not while a statement runs", () => {
    const onRunAll = vi.fn();
    const view = render(<SqlEditorToolbar {...base} onRunAll={onRunAll} />);
    fireEvent.click(screen.getByRole("button", { name: "Run All" }));
    expect(onRunAll).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /Run Current/ }).title).toMatch(
      /Enter/
    );
    view.rerender(
      <SqlEditorToolbar {...base} onRunAll={onRunAll} isExecuting />
    );
    expect(screen.queryByRole("button", { name: "Run All" })).toBeNull();
  });

  it("names the file action Save as", () => {
    render(<SqlEditorToolbar {...base} onExport={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Save as…" })).toBeTruthy();
  });
});
