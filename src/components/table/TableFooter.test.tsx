import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { TableFooter } from "./TableFooter";

vi.mock("src/components/common/Popover", () => ({
  Popover: ({ children, content, open }: any) => (
    <div>
      {children}
      {open ? content : null}
    </div>
  ),
}));

function renderFooter(overrides: Record<string, unknown> = {}) {
  const props = {
    filterBarVisible: false,
    limit: 100,
    offset: 0,
    totalRows: 250,
    loadedMax: 99,
    structPaneTab: "columns",
    viewMode: "data",
    onViewModeChange: vi.fn(),
    onPageChange: vi.fn(),
    onCountExact: vi.fn(),
    onAddColumn: vi.fn(),
    onAddIndex: vi.fn(),
    onAddRow: vi.fn(),
    onFilters: vi.fn(),
    ...overrides,
  } as any;
  render(<TableFooter {...props} />);
  return props;
}

const button = (name: string) => screen.getByRole("button", { name });

describe("TableFooter paging", () => {
  it("pages with labelled first, previous, next and last buttons", () => {
    const props = renderFooter({ offset: 100, loadedMax: 199 });
    expect(screen.getByText("101-200 of 250 rows")).toBeInTheDocument();
    fireEvent.click(button("Next page"));
    fireEvent.click(button("Last page"));
    fireEvent.click(button("Previous page"));
    fireEvent.click(button("First page"));
    expect(props.onPageChange.mock.calls).toEqual([
      [100, 200],
      [100, 200],
      [100, 0],
      [100, 0],
    ]);
    expect(
      screen.getByRole("combobox", { name: "Rows per page" })
    ).toBeTruthy();
  });

  it("stops at the last page of an exact total", () => {
    renderFooter({ offset: 200, loadedMax: 249 });
    expect(button("Next page")).toBeDisabled();
    expect(button("Last page")).toBeDisabled();
  });

  it("keeps Next open past a low estimate while the page is full", () => {
    const props = renderFooter({
      totalRows: 1000,
      rowCountIsEstimated: true,
      offset: 1000,
      loadedMax: 1099,
    });
    expect(screen.getByText("1,001-1,100 of ~1,100 rows")).toBeInTheDocument();
    expect(button("Last page")).toBeDisabled();
    fireEvent.click(button("Next page"));
    expect(props.onPageChange).toHaveBeenCalledWith(100, 1100);
  });

  it("goes back from a partial page past a low estimate", () => {
    const props = renderFooter({
      totalRows: 1000,
      rowCountIsEstimated: true,
      offset: 1200,
      loadedMax: 1240,
    });
    expect(button("Next page")).toBeDisabled();
    fireEvent.click(button("Previous page"));
    fireEvent.click(button("First page"));
    expect(props.onPageChange.mock.calls).toEqual([
      [100, 1100],
      [100, 0],
    ]);
  });

  it("counts loaded rows when the estimate is zero", () => {
    const props = renderFooter({
      totalRows: 0,
      rowCountIsEstimated: true,
      loadedMax: 99,
    });
    expect(screen.getByText("1-100 of ~100 rows")).toBeInTheDocument();
    fireEvent.click(button("Next page"));
    expect(props.onPageChange).toHaveBeenCalledWith(100, 100);
  });

  it("still shows 0 rows for an exact empty result", () => {
    renderFooter({ totalRows: 0, loadedMax: -1 });
    expect(screen.getByText("0 rows")).toBeInTheDocument();
    expect(button("Next page")).toBeDisabled();
  });

  it("ends paging past an estimate once a page is not full", () => {
    renderFooter({
      totalRows: 1000,
      rowCountIsEstimated: true,
      offset: 1000,
      loadedMax: 1040,
    });
    expect(button("Next page")).toBeDisabled();
  });
});

describe("TableFooter count and filters", () => {
  it("offers an exact count only for an estimated total", () => {
    renderFooter();
    expect(screen.queryByRole("button", { name: /rows/ })).toBeNull();
    expect(screen.getByText("1-100 of 250 rows")).toBeInTheDocument();
  });

  it("opens the exact count for an estimate", () => {
    const props = renderFooter({ totalRows: 5000, rowCountIsEstimated: true });
    fireEvent.click(screen.getByTitle("Estimated total: count exactly"));
    fireEvent.click(button("Count"));
    expect(props.onCountExact).toHaveBeenCalledWith(true);
  });

  it("shows how many filters apply, also with the bar hidden", () => {
    const props = renderFooter({ appliedFilterCount: 2 });
    fireEvent.click(button("Filters, 2 applied"));
    expect(props.onFilters).toHaveBeenCalled();
    expect(button("Filters, 2 applied")).toHaveAttribute(
      "aria-pressed",
      "false"
    );
  });

  it("offers Export when the table can be exported", () => {
    const onExport = vi.fn();
    renderFooter({ onExport });
    fireEvent.click(button("Export"));
    expect(onExport).toHaveBeenCalled();
  });
});
