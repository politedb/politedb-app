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
    name: /^Save |Saving…/,
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
      expect(confirmButton().textContent).toBe("Save 1 change")
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
    const summary = screen.getByText("Summary");
    expect(
      alert.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });
});

describe("SaveChangesDialog readability", () => {
  const longSql = `CREATE TABLE "public"."wide" (\n${Array.from(
    { length: 8 },
    (_, i) => `  c${i} int`
  ).join(",\n")}\n);`;

  it("expands a long statement and copies all statements", async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.assign(navigator, { clipboard: { writeText } });
    renderDialog({ newTableSql: [longSql, 'CREATE TABLE "b" (id int);'] });

    const toggle = screen.getByRole("button", { name: "Show all" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(
      screen
        .getByRole("button", { name: "Show less" })
        .getAttribute("aria-expanded")
    ).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Copy all" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0]![0]).toContain('CREATE TABLE "b"');
    expect(writeText.mock.calls[0]![0]).toContain('"wide"');
  });

  it("labels changes plainly and counts them on the save button", () => {
    renderDialog({
      newTableSql: [],
      patchMap: deletePatchMap(),
      activeScreen: "tab1",
      getRowAt: (_key, index) => (index === 0 ? [1, null] : [2, "x"]),
    });
    expect(screen.getByText("Change")).toBeTruthy();
    expect(screen.getByText("Delete")).toBeTruthy();
    expect(confirmButton().textContent).toBe("Save 2 changes");
    // The table name heads its rows once.
    expect(screen.getAllByText("public.users")).toHaveLength(1);
    expect(screen.getByText("Changed rows (2)")).toBeTruthy();
  });

  it("lets the keyboard reach each statement's copy button", () => {
    renderDialog();
    const copy = screen.getByRole("button", { name: "Copy statement" });
    expect(copy.className).toContain("focus-visible:opacity-100");
  });
});

describe("SaveChangesDialog keyboard", () => {
  const modEnter = () =>
    fireEvent.keyDown(document, {
      key: "Enter",
      metaKey: true,
      ctrlKey: true,
    });

  it("focuses Save and saves on Mod+Enter", () => {
    const onConfirm = vi.fn();
    renderDialog({ onConfirm });
    expect(document.activeElement).toBe(confirmButton());
    modEnter();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("focuses Cancel and ignores Mod+Enter when the save cannot be undone", () => {
    const onConfirm = vi.fn();
    renderDialog({
      onConfirm,
      newTableSql: [],
      patchMap: deletePatchMap(),
      activeScreen: "tab1",
      getRowAt: (_key, index) => (index === 0 ? [1, null] : [2, "x"]),
    });
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Cancel" })
    );
    modEnter();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("ignores Mod+Enter when nothing would run", () => {
    const onConfirm = vi.fn();
    renderDialog({
      onConfirm,
      newTableSql: [],
      objectNotices: [
        { kind: "skipped", key: "k", name: "f", reason: "its SQL is empty" },
      ],
    });
    modEnter();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
