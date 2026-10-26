import { fireEvent, render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { ImportTableDialog } from "./ImportTableDialog";

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
  it("previews values under the table column they will fill", () => {
    renderDialog();
    const preview = screen.getByText("Table preview").parentElement!;
    const headers = [...preview.querySelectorAll("th")].map(
      (th) => th.textContent
    );
    const firstRow = [...preview.querySelectorAll("tbody tr")][0]!;
    const cells = [...firstRow.querySelectorAll("td")].map(
      (td) => td.textContent
    );
    // Table order, each value from its mapped CSV column.
    expect(headers).toEqual(["id", "email", "name"]);
    expect(cells).toEqual(["1", "ada@example.com", "Ada"]);
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

  it("says what is running instead of a progress bar it cannot fill", () => {
    const { rerender } = render(
      <ImportTableDialog
        open
        schema="public"
        tableName="users"
        columns={columns}
        dataPreview={{ headers: ["id"], rows: [["1"], ["2"]] }}
        error={null}
        importing
        progress={{ imported: 0, total: 2 }}
        handleClose={vi.fn()}
        onImport={vi.fn()}
      />
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Importing 2 rows into public.users…"
    );
    expect(screen.queryByRole("progressbar")).toBeNull();
    rerender(
      <ImportTableDialog
        open
        schema="public"
        tableName="users"
        columns={columns}
        dataPreview={null}
        error={null}
        importing={false}
        progress={{ imported: 2, total: 2 }}
        handleClose={vi.fn()}
        onImport={vi.fn()}
      />
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Imported 2 rows into public.users."
    );
    expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
  });
});
