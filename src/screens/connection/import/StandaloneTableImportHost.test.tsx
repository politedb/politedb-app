import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { StandaloneTableImportHost } from "./StandaloneTableImportHost";
import { useScreenStore } from "src/stores/screen";

// jsdom has neither ResizeObserver nor a 2D canvas (the preview grid).
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", NoopResizeObserver);
HTMLCanvasElement.prototype.getContext = (() => null) as never;

const mocks = vi.hoisted(() => ({
  openDialog: vi.fn(),
  loadMetadata: vi.fn(),
  importCsv: vi.fn(),
  readTextFile: vi.fn(),
}));
vi.mock("src/lib/system-dialog", () => ({
  openDialog: mocks.openDialog,
  showMessage: vi.fn(),
}));
vi.mock("src/lib/system-fs", () => ({
  readTextFile: mocks.readTextFile,
}));
vi.mock("src/lib/tauri", () => ({
  operationImportCsvTransaction: mocks.importCsv,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));
vi.mock("../export/standalone-export/loadStandaloneExportMetadata", () => ({
  loadStandaloneExportMetadata: mocks.loadMetadata,
  sanitizeStandaloneExportError: (e: unknown) =>
    e instanceof Error ? e.message : String(e),
}));

const target = {
  requestId: "r1",
  connectionId: "c1",
  engine: "postgres" as const,
  schema: "public",
  tableName: "users",
};

function renderHost(overrides: Record<string, unknown> = {}) {
  const onClearTarget = vi.fn();
  const onImported = vi.fn();
  render(
    <StandaloneTableImportHost
      profileScreenId="t1"
      runtimeConnectionId="c1"
      engine="postgres"
      target={target}
      onClearTarget={onClearTarget}
      onImported={onImported}
      {...overrides}
    />
  );
  return { onClearTarget, onImported };
}

beforeEach(() => {
  useScreenStore.setState({
    profileTabs: [{ id: "t1", isLocked: false } as never],
  });
  mocks.readTextFile.mockReset().mockResolvedValue("id,name\n1,Ada\n");
  mocks.openDialog.mockReset().mockResolvedValue("/data/users.csv");
  mocks.loadMetadata.mockReset().mockResolvedValue({
    columns: [
      { name: "id", db_type: "int" },
      { name: "name", db_type: "text" },
    ],
    constraints: null,
    totalRows: null,
  });
  mocks.importCsv.mockReset().mockResolvedValue({ imported: 1 });
});

describe("StandaloneTableImportHost", () => {
  it("opens the import dialog after choosing a file, without a table tab", async () => {
    renderHost();
    await waitFor(() =>
      expect(screen.getByText("Import CSV data")).toBeTruthy()
    );
    expect(screen.getByText("public.users")).toBeTruthy();
    expect(mocks.loadMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ schema: "public", tableName: "users" })
    );
  });

  it("does nothing when the file choice is cancelled", async () => {
    mocks.openDialog.mockResolvedValue(null);
    const { onClearTarget } = renderHost();
    await waitFor(() => expect(onClearTarget).toHaveBeenCalled());
    expect(mocks.loadMetadata).not.toHaveBeenCalled();
    expect(screen.queryByText("Import CSV data")).toBeNull();
  });

  it("shows a column-loading failure inline and retries", async () => {
    mocks.loadMetadata.mockRejectedValueOnce(new Error("permission denied"));
    renderHost();
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "permission denied"
      )
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() =>
      expect(screen.getByText("Import CSV data")).toBeTruthy()
    );
  });

  it("imports and tells the screen the table changed", async () => {
    const { onImported } = renderHost();
    await waitFor(() =>
      expect(screen.getByText("Import CSV data")).toBeTruthy()
    );
    // The column mapping is guessed right after the dialog opens.
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Import" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(onImported).toHaveBeenCalledWith("t1", target));
    expect(mocks.importCsv).toHaveBeenCalledWith(
      expect.objectContaining({ schema: "public", tableName: "users" })
    );
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Imported 1 row")
    );
  });
});

describe("StandaloneTableImportHost sessions", () => {
  const targetB = { ...target, requestId: "r2", tableName: "orders" };
  const waitImportEnabled = () =>
    waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Import" }) as HTMLButtonElement)
          .disabled
      ).toBe(false)
    );

  function hostElement(
    t: typeof target | null,
    extra: Record<string, unknown> = {}
  ) {
    return (
      <StandaloneTableImportHost
        profileScreenId="t1"
        runtimeConnectionId="c1"
        engine="postgres"
        target={t}
        onClearTarget={vi.fn()}
        onImported={vi.fn()}
        {...extra}
      />
    );
  }

  it("never lets a replaced request's file reach the new table", async () => {
    let finishA!: (text: string) => void;
    mocks.openDialog
      .mockResolvedValueOnce("/data/a.csv")
      .mockResolvedValueOnce("/data/b.csv");
    mocks.readTextFile.mockImplementation((path: string) =>
      path === "/data/a.csv"
        ? new Promise((resolve) => (finishA = resolve))
        : Promise.resolve("id,name\n2,FromB\n")
    );
    const view = render(hostElement(target));
    await waitFor(() => expect(mocks.readTextFile).toHaveBeenCalledTimes(1));
    view.rerender(hostElement(targetB));
    await waitFor(() =>
      expect(screen.getByText("Import CSV data")).toBeTruthy()
    );
    finishA("id,name\n1,FromA\n");
    await waitImportEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(mocks.importCsv).toHaveBeenCalledTimes(1));
    const call = mocks.importCsv.mock.calls[0]![0];
    expect(call.tableName).toBe("orders");
    expect(call.csvText).toContain("FromB");
  });

  it("reports a finished import for the tab it started in", async () => {
    let finish!: () => void;
    mocks.importCsv.mockReturnValue(
      new Promise((resolve) => (finish = () => resolve({ imported: 1 })))
    );
    const onImported = vi.fn();
    const view = render(hostElement(target, { onImported }));
    await waitImportEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(mocks.importCsv).toHaveBeenCalled());
    // The user switches to another connection tab meanwhile.
    view.rerender(
      hostElement(target, {
        onImported,
        profileScreenId: "t2",
        runtimeConnectionId: "c2",
      })
    );
    finish();
    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
    expect(onImported).toHaveBeenCalledWith("t1", target);
  });

  it("does not import once the tab is locked", async () => {
    const onClearTarget = vi.fn();
    render(hostElement(target, { onClearTarget }));
    await waitImportEnabled();
    // Locked through the store (no re-render yet): the click checks it.
    useScreenStore.setState(
      { profileTabs: [{ id: "t1", isLocked: true } as never] },
      false
    );
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    expect(mocks.importCsv).not.toHaveBeenCalled();
    await waitFor(() => expect(onClearTarget).toHaveBeenCalled());
  });

  it("drops a pending request when the tab gets locked", async () => {
    let pick!: (path: string) => void;
    mocks.openDialog.mockReturnValue(new Promise((r) => (pick = r)));
    const onClearTarget = vi.fn();
    render(hostElement(target, { onClearTarget }));
    useScreenStore.setState({
      profileTabs: [{ id: "t1", isLocked: true } as never],
    });
    await waitFor(() => expect(onClearTarget).toHaveBeenCalled());
    pick("/data/users.csv");
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.loadMetadata).not.toHaveBeenCalled();
  });

  it("keeps a submitted import's outcome after the connection changes", async () => {
    let fail!: (e: Error) => void;
    mocks.importCsv.mockReturnValue(
      new Promise((_, reject) => (fail = reject))
    );
    const onClearTarget = vi.fn();
    const view = render(hostElement(target, { onClearTarget }));
    await waitImportEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(mocks.importCsv).toHaveBeenCalled());
    view.rerender(
      hostElement(target, { onClearTarget, runtimeConnectionId: "c2" })
    );
    fail(new Error("server closed the connection"));
    await waitFor(() =>
      expect(screen.getByText("The import stopped.")).toBeTruthy()
    );
    expect(screen.getByText(/server closed the connection/)).toBeTruthy();
    expect(
      screen.getByText(/The connection changed since this import started/)
    ).toBeTruthy();
    // The request was taken over when it arrived; closing is up to the user.
    expect(onClearTarget).toHaveBeenCalledTimes(1);
    // Back to the settings: importing again stays blocked.
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(
      (screen.getByRole("button", { name: "Import" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(screen.queryByText("Import CSV data")).toBeNull()
    );
  });

  it("keeps a submitted session when another import is requested", async () => {
    let finish!: () => void;
    mocks.importCsv.mockReturnValue(
      new Promise((resolve) => (finish = () => resolve({ imported: 1 })))
    );
    const view = render(hostElement(target));
    await waitImportEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(mocks.importCsv).toHaveBeenCalled());
    view.rerender(
      hostElement({ ...target, requestId: "r2", tableName: "orders" })
    );
    finish();
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain("Imported 1 row")
    );
    expect(mocks.openDialog).toHaveBeenCalledTimes(1);
  });

  it("does not start again after leaving and coming back", async () => {
    const onClearTarget = vi.fn();
    const view = render(hostElement(target, { onClearTarget }));
    await waitFor(() => expect(onClearTarget).toHaveBeenCalledTimes(1));
    view.unmount();
    // The screen's request slot was cleared: the host comes back empty.
    render(hostElement(null));
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.openDialog).toHaveBeenCalledTimes(1);
  });

  it("reports an outcome in a toast when its dialog is gone", async () => {
    const { useToastStore } = await import("src/stores/toast");
    useToastStore.setState({ toasts: [] });
    let fail!: (e: Error) => void;
    mocks.importCsv.mockReturnValue(
      new Promise((_, reject) => (fail = reject))
    );
    const view = render(hostElement(target));
    await waitImportEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(mocks.importCsv).toHaveBeenCalled());
    view.unmount();
    fail(new Error("disk full"));
    await waitFor(() =>
      expect(useToastStore.getState().toasts[0]?.message).toContain(
        "The import into public.users stopped: disk full"
      )
    );
    expect(useToastStore.getState().toasts[0]?.message).toContain(
      "Check the table before importing again."
    );
  });
});
