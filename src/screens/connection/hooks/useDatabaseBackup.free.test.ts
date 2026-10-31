import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";
import { useLicenseStore } from "src/stores/license";
import { useProUpgradeStore } from "src/stores/proUpgrade";
import { useScreenStore } from "src/stores/screen";

const mocks = vi.hoisted(() => ({
  openDialog: vi.fn(),
  saveDialog: vi.fn(),
  metadataLoad: vi.fn(),
}));

vi.mock("src/lib/system-dialog", () => ({
  openDialog: (...a: any[]) => mocks.openDialog(...a),
  saveDialog: (...a: any[]) => mocks.saveDialog(...a),
  showMessage: vi.fn(),
}));
vi.mock("src/lib/system-fs", () => ({
  writeFile: vi.fn(),
  readFile: vi.fn(),
}));
vi.mock("src/lib/tauri/query", () => ({
  startSqlQueryStream: vi.fn(),
  runSqlQuery: vi.fn(),
}));
vi.mock("../workspace/ConnectionRuntimeContext", () => ({
  useConnectionRuntimeCtx: () => ({
    profileId: "t1",
    runtimeConnectionId: "conn_1",
    engine: "postgres",
    metaKey: "meta",
    metadata: { load: mocks.metadataLoad },
    refreshSchemaAndTables: vi.fn(),
  }),
}));

import { useDatabaseBackup } from "./useDatabaseBackup";
import { seedTabRuntime } from "src/test/fixtures/tabRuntime";

function setPro(pro_access: boolean) {
  useLicenseStore.setState({ state: { pro_access } as LicenseState });
}

beforeEach(() => {
  vi.clearAllMocks();
  // The user cancels every file dialog: only whether one opened matters here.
  mocks.openDialog.mockResolvedValue(null);
  mocks.saveDialog.mockResolvedValue(null);
  mocks.metadataLoad.mockRejectedValue(new Error("stop"));
  useProUpgradeStore.setState({ feature: null });
  useScreenStore.setState({
    profileTabs: [{ id: "t1", profileId: "p1", label: "db" } as never],
  });
  seedTabRuntime({ tabId: "t1", runtimeId: "conn_1" });
});

describe("useDatabaseBackup is free", () => {
  it.each([false, true])(
    "runs database backup and restore with pro_access=%s, without an upgrade prompt",
    async (pro) => {
      setPro(pro);
      const { result } = renderHook(() => useDatabaseBackup());

      await act(() => result.current.onBackupDatabase("db"));
      expect(mocks.metadataLoad).toHaveBeenCalledTimes(1);

      await act(() => result.current.onRestoreDatabase());
      expect(mocks.openDialog).toHaveBeenCalledTimes(1);

      expect(useProUpgradeStore.getState().feature).toBeNull();
    }
  );

  it("keeps table-level SQL dump import free", async () => {
    setPro(false);
    const { result } = renderHook(() => useDatabaseBackup());
    await act(() => result.current.onImportSqlDump());
    expect(mocks.openDialog).toHaveBeenCalledTimes(1);
    expect(useProUpgradeStore.getState().feature).toBeNull();
  });
});
