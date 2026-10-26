import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import type { PatchMap } from "src/lib/patches/generateSql";
import { SaveChangesDialog } from "./SaveChangesDialog";

function renderDialog(
  props: Partial<Parameters<typeof SaveChangesDialog>[0]> = {}
) {
  const onClose = vi.fn();
  const view = render(
    <SaveChangesDialog
      open
      onClose={onClose}
      onConfirm={vi.fn()}
      patchMap={{}}
      engine="postgres"
      newTableSql={['CREATE TABLE "public"."a" (id int);']}
      {...props}
    />
  );
  return { ...view, onClose };
}

const confirmButton = () =>
  screen.getByRole("button", {
    name: /Confirm & Apply|Saving…/,
  }) as HTMLButtonElement;

function deletePatchMap(): PatchMap {
  return {
    win1: {
      tableWindow: {
        id: "win1",
        type: "table",
        table: { schema: "public", name: "users" },
      },
      tableData: {
        columns: [
          { name: "id", db_type: "int" },
          { name: "note", db_type: "text" },
        ],
        rows: [],
        rowCount: 2,
      } as never,
      patches: {
        update: { data: { "0": { note: "" } } },
        delete: { data: { "1": {} } },
      },
    },
  };
}

describe("SaveChangesDialog saving", () => {
  it("runs one save at a time and shows it is saving", async () => {
    let finish!: () => void;
    const onConfirm = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    const { onClose } = renderDialog({ onConfirm });
    fireEvent.click(confirmButton());
    fireEvent.click(confirmButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(confirmButton().textContent).toBe("Saving…"));
    expect(confirmButton().disabled).toBe(true);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    finish();
    await waitFor(() =>
      expect(confirmButton().textContent).toBe("Confirm & Apply")
    );
  });

  it("stays open with the error when the save fails, and can retry", async () => {
    const onConfirm = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied for table a"))
      .mockResolvedValueOnce(undefined);
    renderDialog({ onConfirm });
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(screen.getByText("Not everything was saved.")).toBeTruthy()
    );
    expect(screen.getByText("permission denied for table a")).toBeTruthy();
    expect(confirmButton().disabled).toBe(false);

    fireEvent.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("Not everything was saved.")).toBeNull()
    );
  });
});

describe("SaveChangesDialog content", () => {
  it("names where the changes go", () => {
    renderDialog({ targetLabel: "Staging · shop" });
    expect(screen.getByText("Staging · shop")).toBeTruthy();
  });

  it("warns about deletes and makes Confirm destructive", () => {
    renderDialog({
      newTableSql: [],
      patchMap: deletePatchMap(),
      activeScreen: "tab1",
      getRowAt: (_key, index) => (index === 0 ? [1, null] : [2, "x"]),
    });
    expect(
      screen.getAllByRole("alert").map((a) => a.textContent)
    ).toContainEqual(expect.stringContaining("deletes 1 row"));
    expect(confirmButton().className).toContain("bg-red-500");
  });

  it("shows SQL NULL and an empty string differently", () => {
    renderDialog({
      newTableSql: [],
      patchMap: deletePatchMap(),
      activeScreen: "tab1",
      getRowAt: (_key, index) => (index === 0 ? [1, null] : [2, "x"]),
    });
    expect(screen.getByTitle("NULL").textContent).toBe("NULL");
    expect(screen.getByTitle("Empty string").textContent).toBe("(empty)");
  });

  it("puts object notices above the summary", () => {
    renderDialog({
      objectNotices: [{ kind: "conflict", key: "obj:x", name: "calc" }],
    });
    const alert = screen.getByRole("alert");
    const summary = screen.getByText("Summary of Changes");
    expect(
      alert.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});
