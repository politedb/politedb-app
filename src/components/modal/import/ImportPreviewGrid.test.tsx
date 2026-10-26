import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { ImportPreviewGrid } from "./ImportPreviewGrid";

// jsdom has neither ResizeObserver nor a 2D canvas.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);
HTMLCanvasElement.prototype.getContext = (() => null) as never;

describe("ImportPreviewGrid", () => {
  it("gives screen readers the values, with NULL spelled out", () => {
    render(
      <ImportPreviewGrid
        columns={[
          { name: "id", db_type: "int" },
          { name: "note", db_type: "text" },
        ]}
        rows={[{ id: "1", note: null }]}
      />
    );
    const table = screen.getByRole("table", { name: "Rows to insert" });
    expect(
      [...table.querySelectorAll("th")].map((th) => th.textContent)
    ).toEqual(["id", "note"]);
    expect(
      [...table.querySelectorAll("tbody td")].map((td) => td.textContent)
    ).toEqual(["1", "NULL"]);
  });

  it("keeps the visual canvas out of the Tab order and the a11y tree", () => {
    const { container } = render(
      <ImportPreviewGrid columns={[{ name: "id", db_type: "int" }]} rows={[]} />
    );
    const hidden = container.querySelector('[aria-hidden="true"]')!;
    expect(hidden).toBeTruthy();
    expect(
      hidden.querySelector(".table-focus-root")!.hasAttribute("tabindex")
    ).toBe(false);
  });
});
