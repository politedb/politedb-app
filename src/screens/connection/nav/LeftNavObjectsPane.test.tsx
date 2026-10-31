import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseObjectItem, OpenWindow } from "src/types";
import { LeftNavObjectsPane } from "./LeftNavObjectsPane";
import { useObjectDraftStore } from "src/stores/objectDrafts";

const mocks = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  runSqlQuery: vi.fn(),
  refresh: vi.fn(),
  showToast: vi.fn(),
  objects: [] as DatabaseObjectItem[],
  windows: [] as OpenWindow[],
  locked: false,
  openObjectDraft: vi.fn(),
  openDatabaseObjectsManager: vi.fn(),
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
    openDatabaseObjectsManager: mocks.openDatabaseObjectsManager,
    openDatabaseCatalog: vi.fn(),
    openObjectDraft: mocks.openObjectDraft,
  }),
}));
// The tab guard (D3) is covered by useDropDatabaseObject.test.ts.
vi.mock("src/lib/runtimeConnection", () => ({
  runtimeWorkIsCurrent: () => () => true,
}));
vi.mock("src/lib/tabs/assertTabTarget", () => ({
  assertTabTarget: () => {},
  TabTargetError: class extends Error {},
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
  mocks.openObjectDraft.mockReset();
  mocks.openDatabaseObjectsManager.mockReset();
  useObjectDraftStore.getState().clearAll();
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

describe("LeftNavObjectsPane drafts", () => {
  const createDraft = (key: string, name: string, schema = "public") =>
    useObjectDraftStore.getState().ensureCreateDraft("profile-1", key, {
      kind: "function",
      form: { schema, name, tableName: "" },
      sql: `CREATE FUNCTION ${name}()`,
    });

  it("lists new-object drafts, open or closed, in counts and search", () => {
    mocks.objects = [];
    createDraft("new:function:a", "calc_total");
    createDraft("new:function:b", "other_schema_fn", "audit");
    renderPane();
    const header = screen.getByRole("button", { name: /^Functions/ });
    expect(header.textContent).toContain("1");
    expect(screen.getByText("calc_total")).toBeTruthy();
    // The schema filter applies to drafts too.
    expect(screen.queryByText("other_schema_fn")).toBeNull();

    fireEvent.click(screen.getByText("calc_total"));
    expect(mocks.openObjectDraft).toHaveBeenCalledWith("new:function:a");
  });

  it("finds drafts by search", () => {
    mocks.objects = [];
    createDraft("new:function:a", "calc_total");
    renderPane();
    fireEvent.input(screen.getByLabelText("Search database objects"), {
      target: { value: "nomatch" },
    });
    expect(screen.queryByText("calc_total")).toBeNull();
    fireEvent.input(screen.getByLabelText("Search database objects"), {
      target: { value: "calc" },
    });
    expect(screen.getByText("calc_total")).toBeTruthy();
  });

  it("tints an object with unsaved edits even when its tab is closed", () => {
    const store = useObjectDraftStore.getState();
    store.ensureEditDraft("profile-1", `obj:${fn.id}`, fn);
    store.applyDefinition(
      "profile-1",
      `obj:${fn.id}`,
      useObjectDraftStore.getState().drafts["profile-1"]![`obj:${fn.id}`]!
        .generation,
      "CREATE FUNCTION recalc()",
      fn
    );
    renderPane();
    const clean = screen.getByTitle("public.recalc").className;
    store.setSql("profile-1", `obj:${fn.id}`, "CREATE FUNCTION recalc2()");
    renderPane();
    const dirty = screen.getAllByTitle("public.recalc")[1]!.className;
    expect(dirty).not.toBe(clean);
  });

  it("New object starts a draft from a template", () => {
    renderPane();
    fireEvent.click(screen.getByTitle("New object"));
    const opts = mocks.openDatabaseObjectsManager.mock.calls[0]?.[0];
    expect(opts.createInit.kind).toBe("function");
    expect(opts.createInit.form.schema).toBe("public");
    expect(opts.createInit.sql).toContain("new_function");
  });

  it("warns that dropping discards unsaved edits", async () => {
    const store = useObjectDraftStore.getState();
    store.ensureEditDraft("profile-1", `obj:${fn.id}`, fn);
    store.applyDefinition(
      "profile-1",
      `obj:${fn.id}`,
      useObjectDraftStore.getState().drafts["profile-1"]![`obj:${fn.id}`]!
        .generation,
      "v1",
      fn
    );
    store.setSql("profile-1", `obj:${fn.id}`, "v2");
    mocks.confirmDialog.mockResolvedValue(false);
    renderPane();
    fireEvent.click(openDrop());
    await waitFor(() => expect(mocks.confirmDialog).toHaveBeenCalled());
    expect(mocks.confirmDialog.mock.calls[0]![0]).toContain(
      "unsaved edits to it will be discarded"
    );
  });

  it("removes the draft of a dropped object", async () => {
    useObjectDraftStore
      .getState()
      .ensureEditDraft("profile-1", `obj:${fn.id}`, fn);
    mocks.confirmDialog.mockResolvedValue(true);
    mocks.runSqlQuery.mockResolvedValue({});
    renderPane();
    fireEvent.click(openDrop());
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(
      useObjectDraftStore.getState().drafts["profile-1"]?.[`obj:${fn.id}`]
    ).toBeUndefined();
  });
});
