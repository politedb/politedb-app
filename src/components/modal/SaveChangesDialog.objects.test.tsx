import { render, screen } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { SaveChangesDialog } from "./SaveChangesDialog";

function renderDialog(props: Partial<Parameters<typeof SaveChangesDialog>[0]>) {
  return render(
    <SaveChangesDialog
      open
      onClose={() => {}}
      onConfirm={vi.fn()}
      patchMap={{}}
      engine="postgres"
      {...props}
    />
  );
}

describe("SaveChangesDialog object notices", () => {
  it("lists skipped work and blocks Confirm when nothing would run", () => {
    renderDialog({
      objectNotices: [
        {
          kind: "skipped",
          key: "new:function:a",
          name: "new_function",
          reason: "its SQL is empty",
        },
      ],
    });
    expect(screen.getByRole("status").textContent).toContain(
      "new_function — its SQL is empty."
    );
    expect(screen.getByText("Nothing to run yet.")).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Confirm & Apply" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
  });

  it("warns about overwriting a newer definition next to the SQL", () => {
    renderDialog({
      objectSql: ["CREATE OR REPLACE FUNCTION calc() ..."],
      objectNotices: [{ kind: "conflict", key: "obj:x", name: "calc" }],
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "calc — saving replaces that newer definition."
    );
    const confirm = screen.getByRole("button", { name: "Confirm & Apply" });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });
});
