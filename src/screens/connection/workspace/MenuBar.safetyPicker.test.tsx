import { act, fireEvent, render, screen } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenStore } from "src/stores/screen";
import { handleConnectionTabShortcut } from "src/lib/tabs/handleConnectionTabShortcut";
import { requestOpenSafetyModePicker } from "src/lib/queries/querySafetyModes";
import { MenuBar } from "./MenuBar";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: Object.assign(
    (select: (s: unknown) => unknown) => select({ saveNow: async () => {} }),
    { getState: () => ({ scheduleSave: () => {}, saveNow: async () => {} }) }
  ),
}));
vi.mock("./ConnectionRuntimeContext", () => ({
  useConnectionRuntimeCtx: () => ({
    runtimeConnectionId: "rc1",
    engine: "postgres",
  }),
}));
vi.mock("../hooks/useConnectionHealthCheck", () => ({
  useConnectionHealthCheck: () => ({
    status: "ok",
    latencyMs: null,
    recheck: () => {},
  }),
}));
vi.mock("../hooks/useDatabaseBackup", () => ({
  canBackupDatabase: () => true,
  useDatabaseBackup: () => ({
    dbBackupRunning: false,
    dbRestoreRunning: false,
    onBackupDatabase: () => {},
    onRestoreDatabase: () => {},
  }),
}));
vi.mock("src/hooks/useProGate", () => ({
  useProGate: () => ({ requirePro: async () => true }),
}));
vi.mock("src/components/modal/DatabaseManagerDialog", () => ({
  DatabaseManagerDialog: () => null,
}));

const key = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });

beforeEach(() => {
  useScreenStore.setState({
    profileTabs: [
      { id: "tab-1", label: "a", engine: "postgres", profileId: "p1" },
      { id: "tab-2", label: "b", engine: "postgres", profileId: "p2" },
    ] as never,
    activeProfileScreen: "tab-1",
  });
});

function renderMenuBar() {
  return render(<MenuBar onViewModeChange={() => {}} />);
}

describe("MenuBar safety mode picker", () => {
  it("is a menu that opens on the current mode and moves with arrows", () => {
    renderMenuBar();
    fireEvent.click(screen.getByTitle("Safety mode"));
    const menu = screen.getByRole("menu", { name: "Safety mode" });
    const items = screen.getAllByRole("menuitemradio");
    expect(menu).toBeTruthy();
    expect(document.activeElement).toBe(items[0]);
    expect(items[0]!.getAttribute("aria-checked")).toBe("true");

    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(items[1]!, { key: "End" });
    expect(document.activeElement).toBe(items[3]);

    fireEvent.keyDown(items[3]!, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(screen.getByTitle("Safety mode"));
  });

  it("keeps tab shortcuts from switching connections while it is open", () => {
    renderMenuBar();
    act(() => requestOpenSafetyModePicker());
    expect(screen.getByRole("menu", { name: "Safety mode" })).toBeTruthy();

    for (const init of [
      { key: "2", metaKey: true },
      { key: "9", metaKey: true },
      { key: "Tab", ctrlKey: true },
    ]) {
      const event = key(init);
      expect(handleConnectionTabShortcut(event, true)).toBe(true);
      expect(event.defaultPrevented).toBe(true);
      expect(useScreenStore.getState().activeProfileScreen).toBe("tab-1");
    }

    fireEvent.keyDown(screen.getAllByRole("menuitemradio")[0]!, {
      key: "Escape",
    });
    expect(
      handleConnectionTabShortcut(key({ key: "2", metaKey: true }), true)
    ).toBe(true);
    expect(useScreenStore.getState().activeProfileScreen).toBe("tab-2");
  });
});
