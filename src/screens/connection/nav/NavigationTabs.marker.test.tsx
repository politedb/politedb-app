import {
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import { windowIdForDraftKey } from "src/lib/objectDraftKey";
import { useConnectionStore } from "src/stores/connection";
import { useObjectDraftStore } from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import type { OpenWindow } from "src/types";
import {
  ConnectionActionsProvider,
  type ConnectionActions,
} from "../workspace/ConnectionActionsContext";
import { NavigationTabs } from "./NavigationTabs";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const fn = buildDatabaseObjectItem({
  engine: "postgres",
  kind: "function",
  schema: "public",
  name: "calc",
  signature: "",
});
const EDIT = `obj:${fn.id}`;
const windows: OpenWindow[] = [
  { id: "sql-1", type: "sql", title: "Query" } as OpenWindow,
  {
    id: "table-1",
    type: "table",
    table: { schema: "public", name: "users" },
  } as OpenWindow,
  {
    id: windowIdForDraftKey(EDIT),
    type: "db-object-manager",
    title: "calc",
    initialKind: "function",
    initialObjectId: fn.id,
  } as OpenWindow,
];

const actions = {
  closeWindow: vi.fn(async () => {}),
  closeWindows: vi.fn(async () => {}),
};

function renderTabs() {
  return render(
    <ConnectionActionsProvider value={actions as unknown as ConnectionActions}>
      <NavigationTabs
        openWindows={windows}
        activeWindowId="sql-1"
        setActiveWindowId={() => {}}
      />
    </ConnectionActionsProvider>
  );
}

const tabOf = (title: string) =>
  screen.getByText(title).closest("[title]") as HTMLElement;

beforeEach(() => {
  actions.closeWindow.mockClear();
  actions.closeWindows.mockClear();
  useObjectDraftStore.getState().clearAll();
  useScreenStore.setState({ activeProfileScreen: "t1" });
  useConnectionStore.setState({ dataPatchMap: {}, newTableData: {} } as never);
});

describe("NavigationTabs unsaved marker", () => {
  it("marks windows with unsaved work only", () => {
    const store = useObjectDraftStore.getState();
    store.ensureEditDraft("t1", EDIT, fn);
    store.applyDefinition(
      "t1",
      EDIT,
      useObjectDraftStore.getState().drafts.t1![EDIT]!.generation,
      "v1",
      fn
    );
    renderTabs();
    expect(screen.queryAllByText("Unsaved changes")).toHaveLength(0);
  });

  it("updates live for object edits and table row changes", () => {
    const store = useObjectDraftStore.getState();
    store.ensureEditDraft("t1", EDIT, fn);
    store.applyDefinition(
      "t1",
      EDIT,
      useObjectDraftStore.getState().drafts.t1![EDIT]!.generation,
      "v1",
      fn
    );
    renderTabs();
    expect(within(tabOf("calc")).queryByText("Unsaved changes")).toBeNull();

    act(() => {
      store.setSql("t1", EDIT, "v2");
      useConnectionStore.setState({
        dataPatchMap: {
          t1: { "table-1": { patches: { update: { users: { r1: {} } } } } },
        },
      } as never);
    });
    expect(within(tabOf("calc")).getByText("Unsaved changes")).toBeTruthy();
    expect(within(tabOf("users")).getByText("Unsaved changes")).toBeTruthy();
    expect(within(tabOf("Query")).queryByText("Unsaved changes")).toBeNull();

    act(() => store.revert("t1", EDIT));
    expect(within(tabOf("calc")).queryByText("Unsaved changes")).toBeNull();
  });
});

describe("NavigationTabs bulk close", () => {
  it("closes others, to the right and all in one call each", () => {
    renderTabs();
    const open = () => fireEvent.contextMenu(tabOf("Query"));
    open();
    fireEvent.click(screen.getByText("Close Others"));
    expect(actions.closeWindows).toHaveBeenLastCalledWith([
      "table-1",
      windowIdForDraftKey(EDIT),
    ]);
    open();
    fireEvent.click(screen.getByText("Close to the Right"));
    expect(actions.closeWindows).toHaveBeenLastCalledWith([
      "table-1",
      windowIdForDraftKey(EDIT),
    ]);
    open();
    fireEvent.click(screen.getByText("Close All"));
    expect(actions.closeWindows).toHaveBeenLastCalledWith(
      windows.map((w) => w.id)
    );
    expect(actions.closeWindows).toHaveBeenCalledTimes(3);
    expect(actions.closeWindow).not.toHaveBeenCalled();
  });
});
