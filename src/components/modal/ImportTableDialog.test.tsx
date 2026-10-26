import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { ImportTableDialog, previewTableData } from "./ImportTableDialog";

// jsdom has neither ResizeObserver nor a 2D canvas (the preview grid).
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const columns = [
  { name: "id", db_type: "int" },
  { name: "email", db_type: "text" },
  { name: "name", db_type: "text" },
];

function renderDialog(
  props: Partial<Parameters<typeof ImportTableDialog>[0]> = {}
) {
  const handleClose = vi.fn();
  const view = render(
    <ImportTableDialog
      open
      schema="public"
      tableName="users"
      columns={columns}
      dataPreview={{
        // CSV order differs from the table: name before email.
        headers: ["Name", "EMAIL", "id"],
        rows: [["Ada", "ada@example.com", "1"]],
      }}
      error={null}
      importing={false}
      progress={null}
      handleClose={handleClose}
      onImport={vi.fn()}
      {...props}
    />
  );
  return { ...view, handleClose };
}

/** Pick an option the way a user does (a native change event). */
function choose(el: HTMLSelectElement, value: string) {
  el.value = value;
  fireEvent(el, new Event("change", { bubbles: true }));
}

const select = (column: string) =>
  screen
    .getByText(column, { selector: "td" })
    .closest("tr")!
    .querySelector("select") as HTMLSelectElement;

describe("ImportTableDialog", () => {
  it("previews mapped table columns, in table order, in the data grid", () => {
    renderDialog();
    expect(screen.getByTestId("import-preview-grid")).toBeTruthy();
    expect(
      previewTableData(
        { headers: ["Name", "EMAIL", "id"], rows: [["Ada", "", "1"]] },
        true,
        [
          { name: "id", csvIndex: 2 },
          { name: "email", csvIndex: 1 },
          { name: "name", csvIndex: 0 },
        ],
        "empty-as-null"
      )
    ).toEqual([{ id: "1", email: null, name: "Ada" }]);
  });

  it("matches CSV headers to columns ignoring case", () => {
    renderDialog();
    expect(select("email").value).toBe("1");
    expect(select("name").value).toBe("0");
  });

  it("keeps a hand-picked mapping when the header option changes", () => {
    renderDialog();
    choose(select("name"), "");
    fireEvent.click(screen.getByLabelText("First row is headers"));
    fireEvent.click(screen.getByLabelText("First row is headers"));
    expect(select("name").value).toBe("");
    expect(select("email").value).toBe("1");
  });

  it("shows an import error inline and stays open", () => {
    const { handleClose } = renderDialog({
      error: "Import failed at data row 3: duplicate key value",
    });
    expect(screen.getAllByRole("alert")[0]!.textContent).toContain(
      "duplicate key value"
    );
    expect(handleClose).not.toHaveBeenCalled();
    expect(select("email").value).toBe("1");
  });

  it("blocks the import until required columns are mapped", () => {
    renderDialog({ requiredColumns: ["email"] });
    choose(select("email"), "");
    expect(screen.getByRole("alert").textContent).toContain(
      "Choose a CSV column for email"
    );
    const importButton = screen.getByRole("button", { name: "Import" });
    expect((importButton as HTMLButtonElement).disabled).toBe(true);
    choose(select("email"), "1");
    expect(
      (screen.getByRole("button", { name: "Import" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });
});

describe("ImportTableDialog readability", () => {
  it("offers the detected separator and lets the user change it", () => {
    const onDelimiterChange = vi.fn();
    renderDialog({ delimiter: ";", onDelimiterChange });
    const separator = screen.getByLabelText("Separator") as HTMLSelectElement;
    expect(separator.value).toBe(";");
    choose(separator, "\t");
    expect(onDelimiterChange).toHaveBeenCalledWith("\t");
  });

  it("groups validation problems by column with example rows", () => {
    renderDialog({
      columns: [{ name: "age", db_type: "int" }],
      dataPreview: {
        headers: ["age"],
        rows: Array.from({ length: 7 }, (_, i) => [`x${i}`]),
      },
    });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("7 values need fixing");
    expect(alert.textContent).toContain(
      "age: Invalid number — rows 1, 2, 3, 4, 5 and 2 more"
    );
  });

  it("shows only a progress view while running, then the result", () => {
    const props = {
      open: true,
      schema: "public",
      tableName: "users",
      columns,
      error: null,
      handleClose: vi.fn(),
      onImport: vi.fn(),
    };
    const { rerender } = render(
      <ImportTableDialog
        {...props}
        dataPreview={{ headers: ["id"], rows: [["1"], ["2"]] }}
        importing
        progress={{ imported: 0, total: 2 }}
      />
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Importing 2 rows…"
    );
    expect(screen.getByRole("progressbar")).toBeTruthy();
    // The settings are not shown while it runs.
    expect(screen.queryByText("Column mapping")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "Close" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    rerender(
      <ImportTableDialog
        {...props}
        dataPreview={null}
        importing={false}
        progress={{ imported: 2, total: 2 }}
      />
    );
    expect(screen.getByRole("status").textContent).toContain("Imported 2 rows");
    expect(screen.getByText("public.users")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Close" }) as HTMLButtonElement)
        .disabled
    ).toBe(false);
  });
});

/** Render a run that ends with `error` (importing true, then false). */
function renderFailedRun(extra: Record<string, unknown>) {
  const props = {
    open: true,
    schema: "public",
    tableName: "users",
    columns,
    dataPreview: { headers: ["id"], rows: [["1"]] },
    progress: null,
    handleClose: vi.fn(),
    onImport: vi.fn(),
    ...extra,
  };
  const view = render(
    <ImportTableDialog
      {...props}
      error={null}
      importing
      progress={{ imported: 0, total: 1 }}
    />
  );
  view.rerender(
    <ImportTableDialog
      {...props}
      error={"Import failed at data row 1: duplicate key"}
      importing={false}
    />
  );
  return view;
}

describe("ImportTableDialog failure wording", () => {
  it("shows only the error after a failed run, never promising nothing was saved", async () => {
    renderFailedRun({ usesTransaction: true });
    await waitFor(() =>
      expect(screen.getByText("The import stopped.")).toBeTruthy()
    );
    expect(screen.getByText(/duplicate key/)).toBeTruthy();
    expect(screen.getByText(/usually nothing was saved/)).toBeTruthy();
    expect(screen.queryByText("Nothing was imported.")).toBeNull();
    expect(screen.queryByText("Column mapping")).toBeNull();
  });

  it("warns that earlier rows may be saved where it runs row by row", async () => {
    renderFailedRun({ usesTransaction: false });
    await waitFor(() =>
      expect(
        screen.getByText(/Rows before the failing one may already be saved/)
      ).toBeTruthy()
    );
  });

  it("goes back to the settings without the old error", async () => {
    renderFailedRun({ usesTransaction: true });
    await waitFor(() =>
      expect(screen.getByText("The import stopped.")).toBeTruthy()
    );
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText("Column mapping")).toBeTruthy();
    expect(screen.queryByText(/duplicate key/)).toBeNull();
  });

  it("mentions a failed reload with the imported count", () => {
    renderDialog({
      dataPreview: null,
      progress: { imported: 3, total: 3 },
      error: "The table could not be reloaded: timeout",
      usesTransaction: true,
    });
    expect(screen.getByRole("status").textContent).toContain("Imported 3 rows");
    expect(
      screen.getByText("The table could not be reloaded: timeout")
    ).toBeTruthy();
  });

  it("shows a problem found before running in the settings", () => {
    renderDialog({ error: "No CSV columns match table columns." });
    expect(screen.getByText("The import could not start.")).toBeTruthy();
  });
});

describe("ImportTableDialog layout", () => {
  const mappingDetails = () =>
    screen.getByText("Column mapping").closest("details") as HTMLDetailsElement;

  it("folds the mapping when every column is matched", () => {
    renderDialog({
      columns: [
        { name: "id", db_type: "int" },
        { name: "name", db_type: "text" },
      ],
      dataPreview: { headers: ["id", "name"], rows: [["1", "Ada"]] },
    });
    expect(mappingDetails().open).toBe(false);
    expect(mappingDetails().textContent).toContain("2 of 2 matched");
    expect(screen.getByText("Preview of the rows to insert")).toBeTruthy();
  });

  it("opens the mapping when a column has no CSV column", () => {
    renderDialog({
      columns: [
        { name: "id", db_type: "int" },
        { name: "missing", db_type: "text" },
      ],
      dataPreview: { headers: ["id"], rows: [["1"]] },
    });
    expect(mappingDetails().open).toBe(true);
    expect(mappingDetails().textContent).toContain("1 of 2 matched");
  });

  it("keeps option hints as tooltips", () => {
    renderDialog();
    expect(
      screen
        .getByLabelText("Empty values as NULL")
        .closest("[title]")!
        .getAttribute("title")
    ).toBe("Otherwise an empty cell is saved as an empty string.");
  });
});

describe("ImportTableDialog with the wrong separator", () => {
  const commaFile = {
    // Read with ";": one column holding the whole comma line.
    headers: ["id,email,name"],
    rows: [["1,ada@example.com,Ada"]],
  };

  it("explains the empty preview and offers the likely separator", () => {
    const onDelimiterChange = vi.fn();
    renderDialog({ dataPreview: commaFile, delimiter: ";", onDelimiterChange });
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Only one column was found");
    fireEvent.click(screen.getByRole("button", { name: "Use Comma (,)" }));
    expect(onDelimiterChange).toHaveBeenCalledWith(",");
  });

  it("shows Skip, not a stale choice, after the columns change", () => {
    const view = renderDialog({ delimiter: "," });
    expect(select("email").value).toBe("1");
    view.rerender(
      <ImportTableDialog
        open
        schema="public"
        tableName="users"
        columns={columns}
        dataPreview={commaFile}
        delimiter=";"
        error={null}
        importing={false}
        progress={null}
        handleClose={vi.fn()}
        onImport={vi.fn()}
      />
    );
    const email = screen.getByLabelText(
      "CSV column for email"
    ) as HTMLSelectElement;
    expect(email.value).toBe("");
    expect(email.selectedOptions[0]?.textContent).toBe("Skip");
  });
});
