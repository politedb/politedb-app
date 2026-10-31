import { fireEvent, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProfileStore } from "src/stores/profile";
import { useScreenStore } from "src/stores/screen";
import { DatabaseManagerDialog } from "./DatabaseManagerDialog";
import { seedTabRuntime } from "src/test/fixtures/tabRuntime";

const m = vi.hoisted(() => ({
  runSqlQuery: vi.fn(),
  showMessage: vi.fn(),
  close: vi.fn(),
}));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: m.runSqlQuery }));
vi.mock("src/lib/system-dialog", () => ({ showMessage: m.showMessage }));
vi.mock("src/screens/connection/lib/connectionTabClose", () => ({
  requestCloseConnectionTab: m.close,
}));
vi.mock("src/lib/tauri/security", () => ({
  securityTouchIdAuthenticate: vi.fn(),
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

beforeEach(() => {
  m.runSqlQuery
    .mockReset()
    .mockImplementation(async (_id, sql: string) =>
      /DROP/.test(sql)
        ? {}
        : { rows: [[{ t: "Str", v: "app" }], [{ t: "Str", v: "test1" }]] }
    );
  m.showMessage.mockReset().mockResolvedValue(undefined);
  m.close.mockReset().mockImplementation(async (id: string) => {
    useScreenStore.setState({
      profileTabs: useScreenStore
        .getState()
        .profileTabs.filter((tab) => tab.id !== id),
    });
  });
  useProfileStore.setState({
    profiles: [
      {
        id: "p1",
        label: "Athena",
        engine: "postgres",
        input: { engine: "postgres", postgres: { database: "app" } },
      },
    ] as never,
  });
  useScreenStore.setState({
    profileTabs: [
      {
        id: "home",
        profileId: "p1",
        label: "Athena",
        engine: "postgres",
        target: { kind: "default" },
        runtimeConnectionId: "c1",
      },
      {
        id: "t1",
        profileId: "p1",
        engine: "postgres",
        target: { kind: "override", database: "test1" },
        databaseOverride: "test1",
      },
    ] as never,
  });
  seedTabRuntime({ tabId: "home", runtimeId: "c1" });
  seedTabRuntime({ tabId: "t1", runtimeId: "c2" });
});

function renderDialog(tabId: string, runtimeId = "c1") {
  render(
    <DatabaseManagerDialog
      open
      engine="postgres"
      runtimeConnectionId={runtimeId}
      tabId={tabId}
      profileId="p1"
      onClose={vi.fn()}
    />
  );
}

async function askToDrop(name: string) {
  fireEvent.contextMenu(await screen.findByText(name));
  fireEvent.click(screen.getByText("Drop..."));
}

describe("DatabaseManagerDialog drop", () => {
  it("drops from another database after closing the tabs using it", async () => {
    renderDialog("home");
    await askToDrop("test1");
    expect(screen.getByText("Its open tab will be closed first.")).toBeTruthy();
    fireEvent.input(screen.getByPlaceholderText("test1"), {
      target: { value: "test1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Drop" }));
    await waitFor(() =>
      expect(m.runSqlQuery).toHaveBeenCalledWith(
        "c1",
        expect.stringContaining('DROP DATABASE "test1"')
      )
    );
    expect(m.close).toHaveBeenCalledWith("t1");
    // Closed before the DROP ran.
    expect(m.close.mock.invocationCallOrder[0]).toBeLessThan(
      m.runSqlQuery.mock.invocationCallOrder[
        m.runSqlQuery.mock.invocationCallOrder.length - 1
      ]!
    );
  });

  it("explains instead of dropping the database the tab is in", async () => {
    renderDialog("t1", "c2");
    await askToDrop("test1");
    await waitFor(() => expect(m.showMessage).toHaveBeenCalled());
    expect(m.showMessage.mock.calls[0]![0]).toContain(
      'This tab is connected to "test1"'
    );
    expect(screen.queryByPlaceholderText("test1")).toBeNull();
    expect(m.runSqlQuery.mock.calls.some((call) => /DROP/.test(call[1]))).toBe(
      false
    );
  });
});
