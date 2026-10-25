import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { TableStructure } from "src/types";

vi.mock("./TableStructure", () => ({
  TableStructure: (props: { searchQuery: string }) => (
    <div data-testid="columns-search">{props.searchQuery}</div>
  ),
}));
// zustand runs on React's hooks; feed the two setters the pane uses.
vi.mock("src/stores/connection", () => ({
  useConnectionStore: (select: (state: unknown) => unknown) =>
    select({ setTableStructure: () => {}, setTableConstraints: () => {} }),
}));
vi.mock("./TableConstraint", () => ({
  TableConstraints: () => <div />,
}));

import { TableStructurePane } from "./TableStructurePane";

const column = (name: string): TableStructure => ({
  column_name: name,
  data_type: "text",
  is_nullable: true,
  check: "",
  column_default: "",
  foreign_key: "",
  comment: "",
});

function renderPane(
  structure: TableStructure[],
  onDataChange = vi.fn(),
  tableName = "items"
) {
  const props = {
    engine: "postgres" as const,
    profileId: "profile-1",
    activeTableMeta: {
      columns: [],
      structure,
      constraints: [],
      foreignKeys: [],
      sizeInfo: null,
      rowCount: 0,
      busy: false,
      error: null,
    } as never,
    activeTableWindow: {
      id: "table:public.items",
      type: "table",
      table: { schema: "public", name: tableName },
    } as never,
    structPaneTab: "columns" as const,
    setStructPaneTab: () => {},
    tableStructure: structure,
    tableConstraints: [],
    deletedStructureRows: new Set<number>(),
    deletedConstraintRows: new Set<number>(),
    onDataChange,
    onAddNewColumn: () => {},
    onDeleteColumn: () => {},
    onAddIndex: () => {},
    onDeleteIndex: () => {},
  };
  const view = render(<TableStructurePane {...props} />);
  return {
    rerender: (next: TableStructure[]) =>
      view.rerender(<TableStructurePane {...props} tableStructure={next} />),
  };
}

describe("TableStructurePane table name", () => {
  it("says a changed name renames on save and offers to undo it", () => {
    const onDataChange = vi.fn();
    renderPane([column("id")], onDataChange);
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.input(name, { target: { value: "goods" } });
    expect(screen.getByText("Renamed on save")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo the rename" }));
    expect(name.value).toBe("items");
    expect(onDataChange).toHaveBeenLastCalledWith("update", "structure", -1, {
      tableName: "items",
    });
  });

  it("flags an empty name", () => {
    renderPane([column("id")]);
    const name = screen.getByLabelText("Name");
    fireEvent.input(name, { target: { value: "  " } });
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("The name can't be empty.")).toBeTruthy();
  });
});

describe("TableStructurePane table name with spaces", () => {
  it("shows no rename until edited, and none after undo", () => {
    renderPane([column("id")], vi.fn(), " items ");
    expect(screen.queryByText("Renamed on save")).toBeNull();
    const name = screen.getByLabelText("Name") as HTMLInputElement;
    fireEvent.input(name, { target: { value: "goods" } });
    expect(screen.getByText("Renamed on save")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo the rename" }));
    expect(name.value).toBe(" items ");
    expect(screen.queryByText("Renamed on save")).toBeNull();
  });
});

describe("TableStructurePane search", () => {
  it("clears the column search when a column is added", () => {
    const pane = renderPane([column("id")]);
    fireEvent.input(screen.getByPlaceholderText("Search columns..."), {
      target: { value: "zzz" },
    });
    expect(screen.getByTestId("columns-search").textContent).toBe("zzz");
    pane.rerender([column("id"), column("")]);
    expect(screen.getByTestId("columns-search").textContent).toBe("");
  });
});
