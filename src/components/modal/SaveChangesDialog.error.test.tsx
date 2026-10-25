import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { PatchMap } from "src/lib/patches";
import { SaveChangesDialog } from "./SaveChangesDialog";

describe("SaveChangesDialog when SQL cannot be generated", () => {
  it("says why and cannot be confirmed", () => {
    // SQLite cannot alter a column's type: generation throws.
    const patchMap = {
      "table:main.notes": {
        tableWindow: {
          id: "table:main.notes",
          type: "table",
          table: { schema: "main", name: "notes" },
        },
        tableData: {
          columns: [],
          structure: [
            {
              column_name: "body",
              data_type: "text",
              is_nullable: true,
              check: "",
              column_default: "",
              foreign_key: "",
              comment: "",
            },
          ],
          constraints: [],
          foreignKeys: [],
          sizeInfo: null,
          rowCount: 0,
          connectionId: "conn",
          busy: false,
          error: null,
        },
        patches: { update: { structure: { "0": { data_type: "blob" } } } },
      },
    } as unknown as PatchMap;
    const onConfirm = vi.fn();
    render(
      <SaveChangesDialog
        open
        onClose={() => {}}
        onConfirm={onConfirm}
        patchMap={patchMap}
        engine="sqlite"
      />
    );
    expect(screen.getByRole("alert").textContent).toMatch(
      /can't be saved: .*SQLite|can't be saved: .*sqlite/
    );
    const confirm = screen.getByRole("button", { name: "Confirm & Apply" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });
});
