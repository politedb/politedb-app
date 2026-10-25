import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseObjectItem, OpenWindow } from "src/types";
import { LeftNavObjectsPane } from "./LeftNavObjectsPane";

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  runSqlQuery: vi.fn(),
  refresh: vi.fn(),
  showToast: vi.fn(),
  objects: [] as DatabaseObjectItem[],
  windows: [] as OpenWindow[],
  locked: false,
}));

vi.mock("src/lib/system-dialog", () => ({
  confirmDialog: mocks.confirmDialog,
}));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: mocks.runSqlQuery }));
vi.mock("src/stores/toast", () => ({ showToast: mocks.showToast }));
vi.mock("../workspace/ConnectionRuntimeContext", () => ({
  useConnectionRuntimeCtx: () => ({
    engine: "postgres",
    metaKey: "meta",
    runtimeConnectionId: "conn-1",
    activeSchema: "public",
    metadata: {
      get: () => ({ schemas: ["public"], objects: mocks.objects }),
    },
    refreshSchemaAndTables: mocks.refresh,
  }),
}));
vi.mock("../hooks/useConnectionWindows", () => ({
  useConnectionWindows: () => ({
    openDatabaseObjectsManager: vi.fn(),
    openDatabaseCatalog: vi.fn(),
    selectWindow: vi.fn(),
  }),
}));
vi.mock("src/stores/screen", () => {
  const state = () => ({
    openWindows: { "profile-1": mocks.windows },
    activeWindowId: {},
    profileTabs: [{ id: "profile-1", isLocked: mocks.locked }],
  });
  const useScreenStore = (selector: (s: unknown) => unknown) =>
    selector(state());
  useScreenStore.getState = state;
  return { useScreenStore };
});

const fn: DatabaseObjectItem = {
  id: "function:public:recalc::",
  kind: "function",
  schema: "public",
  name: "recalc",
  signature: "",
  engine: "postgres",
  capability: {
    canList: true,
    canReadDefinition: true,
    canCreate: true,
    canEdit: true,
    canDelete: true,
  },
} as DatabaseObjectItem;

function renderPane() {
  return render(
    <LeftNavObjectsPane
      profileId="profile-1"
      currSchema="public"
      onSchemaChange={() => {}}
    />
  );
}

function openDrop() {
  fireEvent.contextMenu(screen.getByTitle("public.recalc"));
  return screen.getByText("Drop…");
}

beforeEach(() => {
  mocks.confirmDialog.mockReset();
  mocks.runSqlQuery.mockReset();
  mocks.refresh.mockReset().mockResolvedValue(undefined);
  mocks.showToast.mockReset();
  mocks.objects = [fn];
  mocks.windows = [];
  mocks.locked = false;
});

describe("LeftNavObjectsPane drop", () => {
  it("confirms natively and runs the drop once", async () => {
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.runSqlQuery.mockResolvedValue({});
    renderPane();
    fireEvent.click(openDrop());
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.confirmDialog).toHaveBeenCalledTimes(1);
    expect(mocks.runSqlQuery).toHaveBeenCalledTimes(1);
    expect(mocks.showToast).toHaveBeenCalledWith(
      expect.stringContaining("Dropped function"),
      { tone: "success" }
    );
  });

  it("blocks a second drop while the first is running, across remounts", async () => {
    mocks.confirmDialog.mockResolvedValue(true);
    let finish!: () => void;
    mocks.runSqlQuery.mockReturnValue(
      new Promise<void>((resolve) => (finish = resolve))
    );
    const first = renderPane();
    fireEvent.click(openDrop());
    await waitFor(() => expect(mocks.runSqlQuery).toHaveBeenCalledTimes(1));

    // Switching sidebar tabs remounts the pane.
    first.unmount();
    renderPane();
    const again = openDrop();
    expect(again.closest("button")?.disabled ?? true).toBe(true);
    fireEvent.click(again);
    await Promise.resolve();
    expect(mocks.confirmDialog).toHaveBeenCalledTimes(1);
    expect(mocks.runSqlQuery).toHaveBeenCalledTimes(1);

    finish();
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });

  it("runs nothing when cancelled, and reports a failed confirmation", async () => {
    mocks.confirmDialog.mockResolvedValueOnce(false);
    renderPane();
    fireEvent.click(openDrop());
    await waitFor(() => expect(mocks.confirmDialog).toHaveBeenCalled());
    expect(mocks.runSqlQuery).not.toHaveBeenCalled();

    mocks.confirmDialog.mockRejectedValueOnce(new Error("dialog failed"));
    fireEvent.click(openDrop());
    await waitFor(() =>
      expect(mocks.showToast).toHaveBeenCalledWith("dialog failed", {
        tone: "error",
      })
    );
    expect(mocks.runSqlQuery).not.toHaveBeenCalled();
  });
});

describe("LeftNavObjectsPane drop state and locked profiles", () => {
  it("re-enables an open menu in a remounted pane when the drop ends", async () => {
    let answer!: (ok: boolean) => void;
    mocks.confirmDialog.mockReturnValue(
      new Promise<boolean>((resolve) => (answer = resolve))
    );
    const first = renderPane();
    fireEvent.click(openDrop());
    await waitFor(() => expect(mocks.confirmDialog).toHaveBeenCalled());

    first.unmount();
    renderPane();
    const drop = () => screen.getByText("Drop…").closest("button")!;
    fireEvent.contextMenu(screen.getByTitle("public.recalc"));
    expect(drop().disabled).toBe(true);

    answer(false);
    await waitFor(() => expect(drop().disabled).toBe(false));
    expect(mocks.runSqlQuery).not.toHaveBeenCalled();
  });

  it("does not drop on a locked profile", async () => {
    mocks.locked = true;
    renderPane();
    const drop = openDrop();
    expect(drop.closest("button")!.disabled).toBe(true);
    fireEvent.click(drop);
    await Promise.resolve();
    expect(mocks.confirmDialog).not.toHaveBeenCalled();
    expect(mocks.runSqlQuery).not.toHaveBeenCalled();
  });

  it("does not drop when the profile is locked during the confirmation", async () => {
    mocks.confirmDialog.mockImplementation(async () => {
      mocks.locked = true;
      return true;
    });
    renderPane();
    fireEvent.click(openDrop());
    await waitFor(() => expect(mocks.confirmDialog).toHaveBeenCalled());
    await Promise.resolve();
    expect(mocks.runSqlQuery).not.toHaveBeenCalled();
  });
});

describe("LeftNavObjectsPane counts", () => {
  it("counts drafts of new objects with the saved ones", () => {
    mocks.objects = [];
    mocks.windows = [
      {
        id: "draft-1",
        type: "db-object-manager",
        title: "",
        initialKind: "function",
      } as unknown as OpenWindow,
    ];
    renderPane();
    const header = screen.getByRole("button", { name: /^Functions/ });
    expect(header.textContent).toContain("1");
    expect(screen.getByText("new_function")).toBeTruthy();
  });
});
