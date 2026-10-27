import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenStore } from "src/stores/screen";
import { deleteConnectionProfile } from "./deleteConnection";

const m = vi.hoisted(() => ({
  confirmDialog: vi.fn(),
  showMessage: vi.fn(),
  requestClose: vi.fn(),
  hasChanges: vi.fn(),
}));
vi.mock("src/lib/system-dialog", () => ({
  confirmDialog: m.confirmDialog,
  showMessage: m.showMessage,
}));
vi.mock("src/screens/connection/lib/connectionTabClose", () => ({
  requestCloseConnectionTab: m.requestClose,
}));
vi.mock("src/screens/connection/lib/tabDirty", () => ({
  connectionTabHasChanges: m.hasChanges,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const profile = { id: "p1", label: "orders" } as never;
const removeProfile = vi.fn(async () => {});

function setTabs(ids: string[]) {
  useScreenStore.setState({
    profileTabs: ids.map((id) => ({ id, profileId: "p1" })) as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.hasChanges.mockReturnValue(false);
  // Closing really removes the tab, like the real close without changes.
  m.requestClose.mockImplementation(async (tabId: string) => {
    const { profileTabs } = useScreenStore.getState();
    useScreenStore.setState({
      profileTabs: profileTabs.filter((tab) => tab.id !== tabId),
    });
  });
  setTabs([]);
});

describe("deleteConnectionProfile", () => {
  it("deletes after a confirmation naming the connection", async () => {
    m.confirmDialog.mockResolvedValue(true);
    await expect(deleteConnectionProfile(profile, removeProfile)).resolves.toBe(
      true
    );
    expect(m.confirmDialog.mock.calls[0]![0]).toBe(
      'Delete "orders"? This removes the saved connection and cannot be undone.'
    );
    expect(removeProfile).toHaveBeenCalledWith("p1");
  });

  it("keeps everything when cancelled", async () => {
    setTabs(["t1"]);
    m.confirmDialog.mockResolvedValue(false);
    await deleteConnectionProfile(profile, removeProfile);
    expect(m.requestClose).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  it("says its open tabs will close, closes them, then deletes", async () => {
    setTabs(["t1", "t2"]);
    m.confirmDialog.mockResolvedValue(true);
    await deleteConnectionProfile(profile, removeProfile);
    expect(m.confirmDialog.mock.calls[0]![0]).toContain(
      "Its 2 open tabs will be closed."
    );
    expect(m.requestClose.mock.calls.map((c) => c[0])).toEqual(["t1", "t2"]);
    expect(removeProfile).toHaveBeenCalledWith("p1");
  });

  it("refuses while an open tab holds unsaved changes", async () => {
    setTabs(["t1"]);
    m.hasChanges.mockReturnValue(true);
    await expect(deleteConnectionProfile(profile, removeProfile)).resolves.toBe(
      false
    );
    expect(m.showMessage.mock.calls[0]![0]).toContain("unsaved changes");
    expect(m.confirmDialog).not.toHaveBeenCalled();
    expect(m.requestClose).not.toHaveBeenCalled();
    expect(removeProfile).not.toHaveBeenCalled();
  });

  it("does not delete when a tab stays open after closing", async () => {
    setTabs(["t1"]);
    m.confirmDialog.mockResolvedValue(true);
    m.requestClose.mockResolvedValue(undefined); // e.g. its close was held up
    await deleteConnectionProfile(profile, removeProfile);
    expect(removeProfile).not.toHaveBeenCalled();
  });
});
