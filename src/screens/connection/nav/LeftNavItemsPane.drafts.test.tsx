import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  confirmDialog: vi.fn(async () => true),
  showMessage: vi.fn(async () => {}),
  runSqlQuery: vi.fn(),
  actions: {
    closeWindow: vi.fn(async () => {}),
    selectTable: vi.fn(async () => {}),
    dropTable: vi.fn(),
    truncateTable: vi.fn(),
    cloneTable: vi.fn(),
  },
}));

vi.mock("src/lib/system-dialog", () => ({
  confirmDialog: m.confirmDialog,
  showMessage: m.showMessage,
}));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: m.runSqlQuery }));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));
vi.mock("../workspace/ConnectionActionsContext", () => ({
  useConnectionActionsCtx: () => m.actions,
}));
vi.mock("../workspace/ConnectionRuntimeContext", () => ({
  useConnectionRuntimeCtx: () => ({ runtimeConnectionId: "c1" }),
}));

import { LeftNavItemsPane } from "./LeftNavItemsPane";
import { mergeSidebarTables } from "../lib/newTableDrafts";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";

const TAB = "tab-1";
const draft = (tableName: string) =>
  ({ tableName, primaryKey: "id", columns: [] }) as never;

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  useScreenStore.setState({
    profileTabs: [{ id: TAB, profileId: "p1", engine: "postgres" }] as never,
    openWindows: { [TAB]: [] },
    activeWindowId: { [TAB]: null },
  });
  useConnectionStore.setState({ newTableData: {} } as never);
  const store = useConnectionStore.getState();
  store.setNewTableData(TAB, "table:tenant.eu.a", draft("orders"));
  store.setNewTableData(TAB, "table:tenant.eu.b", draft("orders"));
});

function renderSidebar() {
  const tables = mergeSidebarTables({
    tables: [{ schema: "public", name: "orders" }],
    windows: [],
    drafts: useConnectionStore.getState().newTableData[TAB] ?? {},
    activeSchema: "public",
    search: "",
  });
  return render(
    <LeftNavItemsPane
      engine="postgres"
      profileId={TAB}
      schemas={["public"]}
      currSchema="public"
      onSchemaChange={() => {}}
      tableSearchQuery=""
      setTableSearchQuery={() => {}}
      expandedSections={{ views: false, tables: true }}
      setExpandedSections={() => {}}
      filteredTables={tables}
      filteredViews={[]}
      activeWindowId={null}
    />
  );
}

describe("an unsaved table whose schema cannot be told", () => {
  it("is listed on its own and Drop discards only that draft, with no SQL", async () => {
    const { container } = renderSidebar();
    // The real table and both drafts, each its own item.
    // (names render by measured width, empty here: items are told apart
    // by position).
    const items = [...container.querySelectorAll("[data-sidebar-item]")].filter(
      (el) => !el.textContent
    );
    expect(items).toHaveLength(3);

    fireEvent.contextMenu(items[1]!);
    fireEvent.click(screen.getByText("Drop..."));

    await waitFor(() =>
      expect(
        Object.keys(useConnectionStore.getState().newTableData[TAB] ?? {})
      ).toEqual(["table:tenant.eu.b"])
    );
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(m.actions.dropTable).not.toHaveBeenCalled();
  });
});
