import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveAndConnect: vi.fn(),
  save: vi.fn(),
  connectionTest: vi.fn(),
  profileConnectTest: vi.fn(),
  missing: vi.fn(),
  pickDatabase: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("src/lib/distribution", async (importOriginal) => {
  const actual = await importOriginal<typeof import("src/lib/distribution")>();
  return {
    ...actual,
    DISTRIBUTION: "appstore",
    DISTRIBUTION_FEATURES: actual.featuresFor("appstore"),
  };
});
vi.mock("src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri")>()),
  profileSaveAndConnect: (...a: any[]) => mocks.saveAndConnect(...a),
  profileSave: (...a: any[]) => mocks.save(...a),
  connectionTest: (...a: any[]) => mocks.connectionTest(...a),
  profileConnectTest: (...a: any[]) => mocks.profileConnectTest(...a),
}));
vi.mock("src/lib/tauri/fileAccess", () => ({
  fileAccessMissing: (...a: any[]) => mocks.missing(...a),
  fileAccessPickDatabase: (...a: any[]) => mocks.pickDatabase(...a),
  fileAccessPickSshKey: vi.fn(),
}));
vi.mock("src/lib/system-dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/system-dialog")>()),
  confirmDialog: (...a: any[]) => mocks.confirm(...a),
  showMessage: vi.fn(),
}));
vi.mock("src/lib/analytics", () => ({
  trackEvent: vi.fn(),
  errorCode: () => "CODE",
}));

vi.mock("src/stores/screen", () => {
  const state = {
    profileTabs: [],
    addTab: vi.fn(),
    updateTab: vi.fn(),
    setActiveProfileScreen: vi.fn(),
  };
  return {
    useScreenStore: Object.assign(() => state, { getState: () => state }),
  };
});

import { ConnectionFormDialog } from "./ConnectionFormDialog";

const DB_PATH = "/Users/me/data/app.db";

function profile() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    engine: "sqlite",
    label: "Local",
    input: {
      engine: "sqlite",
      label: "Local",
      tags: [],
      sqlite: { path: DB_PATH, statement_timeout_ms: 60000 },
    },
    tags: [],
    created_at: 0,
    updated_at: 0,
  } as any;
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.missing.mockResolvedValue([{ role: "database_folder", path: DB_PATH }]);
});

describe("ConnectionFormDialog file access", () => {
  it("declining access saves and connects nothing", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<ConnectionFormDialog engine="sqlite" initialData={profile()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.saveAndConnect).not.toHaveBeenCalled();
    expect(mocks.pickDatabase).not.toHaveBeenCalled();
  });

  it("cancelling the folder panel saves and connects nothing", async () => {
    mocks.confirm.mockResolvedValue(true);
    mocks.pickDatabase.mockResolvedValue(null);
    render(<ConnectionFormDialog engine="sqlite" initialData={profile()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.pickDatabase).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.saveAndConnect).not.toHaveBeenCalled();
  });

  it("declining access does not run Test", async () => {
    mocks.confirm.mockResolvedValue(false);
    render(<ConnectionFormDialog engine="sqlite" initialData={profile()} />);
    fireEvent.click(screen.getByRole("button", { name: "Test" }));
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.profileConnectTest).not.toHaveBeenCalled();
    expect(mocks.connectionTest).not.toHaveBeenCalled();
  });

  it("a late failure after saving is not retried (no duplicate profile)", async () => {
    mocks.missing.mockResolvedValue([]);
    mocks.saveAndConnect.mockRejectedValue(
      new Error(
        'RUNTIME_CONNECT_FAILED: FILE_ACCESS_REQUIRED:{"role":"database_folder"}'
      )
    );
    render(<ConnectionFormDialog engine="sqlite" initialData={profile()} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.saveAndConnect).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(mocks.saveAndConnect).toHaveBeenCalledTimes(1);
  });

  it("after a failed connect, a new profile is updated, not created again", async () => {
    mocks.missing.mockResolvedValue([]);
    mocks.saveAndConnect.mockRejectedValueOnce(
      new Error("RUNTIME_CONNECT_FAILED: SQLITE_OPEN_FAILED: busy")
    );
    mocks.saveAndConnect.mockResolvedValueOnce({
      profile: { id: "x", label: "Local", input: { tags: [] } },
      connection: { id: "c" },
    });
    const draft = profile();
    delete draft.id;
    render(<ConnectionFormDialog engine="sqlite" initialData={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.saveAndConnect).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.saveAndConnect).toHaveBeenCalledTimes(2));

    const [first, second] = mocks.saveAndConnect.mock.calls.map((c) => c[0]);
    expect(first.mode).toBe("create");
    expect(first.profileId).toBeTruthy();
    expect(second.mode).toBe("update");
    expect(second.profileId).toBe(first.profileId);
  });

  it("Save after a failed connect updates the profile that was already saved", async () => {
    mocks.missing.mockResolvedValue([]);
    mocks.saveAndConnect.mockRejectedValueOnce(
      new Error("RUNTIME_CONNECT_FAILED: SQLITE_OPEN_FAILED: busy")
    );
    mocks.save.mockImplementation(async (a: any) => ({
      id: a.profileId,
      label: "Local",
      input: { tags: [] },
    }));
    const draft = profile();
    delete draft.id;
    render(<ConnectionFormDialog engine="sqlite" initialData={draft} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mocks.saveAndConnect).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));

    const created = mocks.saveAndConnect.mock.calls[0][0];
    const saved = mocks.save.mock.calls[0][0];
    expect(saved.mode).toBe("update");
    expect(saved.profileId).toBe(created.profileId);
  });
});
