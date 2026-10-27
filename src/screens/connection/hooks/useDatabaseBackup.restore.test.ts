import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenStore } from "src/stores/screen";

const m = vi.hoisted(() => ({
  openDialog: vi.fn(),
  confirmDialog: vi.fn(),
  showMessage: vi.fn(),
  readFile: vi.fn(),
  unpack: vi.fn(),
  runSqlQuery: vi.fn(),
  touchId: vi.fn(),
  showToast: vi.fn(),
  refresh: vi.fn(async () => {}),
  rt: { engine: "postgres" as string },
}));

vi.mock("src/lib/system-dialog", () => ({
  openDialog: m.openDialog,
  saveDialog: vi.fn(),
  confirmDialog: m.confirmDialog,
  showMessage: m.showMessage,
}));
vi.mock("src/lib/system-fs", () => ({
  writeFile: vi.fn(),
  readFile: m.readFile,
}));
vi.mock("src/lib/dump/politedbDumbFormat", () => ({
  packSqlToDumb: vi.fn(),
  unpackDumpBytes: m.unpack,
}));
vi.mock("src/lib/tauri/query", () => ({
  startSqlQueryStream: vi.fn(),
  runSqlQuery: m.runSqlQuery,
}));
vi.mock("src/lib/tauri/security", () => ({
  securityTouchIdAuthenticate: m.touchId,
}));
vi.mock("src/stores/toast", () => ({ showToast: m.showToast }));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));
vi.mock("../workspace/ConnectionRuntimeContext", () => ({
  useConnectionRuntimeCtx: () => ({
    profileId: "t1",
    runtimeConnectionId: "conn_1",
    engine: m.rt.engine,
    metaKey: "meta",
    metadata: { load: vi.fn() },
    refreshSchemaAndTables: m.refresh,
  }),
}));

import { canBackupDatabase, useDatabaseBackup } from "./useDatabaseBackup";

const DUMP =
  "CREATE TABLE a (id int);\nINSERT INTO a VALUES (1);\nINSERT INTO a VALUES (2);";

function setMode(mode: string) {
  useScreenStore.setState({
    profileTabs: [
      { id: "t1", profileId: "p1", label: "shop", querySafetyMode: mode },
    ] as never,
  });
}

async function restore(onRefresh?: () => void) {
  const { result } = renderHook(() => useDatabaseBackup());
  await act(() => result.current.onRestoreDatabase(onRefresh, "shop_db"));
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rt.engine = "postgres";
  setMode("default");
  m.openDialog.mockResolvedValue("/backups/shop-backup.dumb");
  m.readFile.mockResolvedValue(new Uint8Array());
  m.unpack.mockResolvedValue({ sql: DUMP, engine: "postgres" });
  m.confirmDialog.mockResolvedValue(true);
  m.runSqlQuery.mockResolvedValue({});
  m.touchId.mockResolvedValue(true);
});

describe("restoring a dump", () => {
  it("asks first, naming the file, the target and what it cannot undo", async () => {
    m.confirmDialog.mockResolvedValue(false);
    await restore();
    const [body, options] = m.confirmDialog.mock.calls[0]!;
    expect(body).toContain('Restore "shop-backup.dumb" into shop (shop_db)?');
    expect(body).toContain("3 SQL statements");
    expect(body).toContain("cannot be undone");
    expect(options).toMatchObject({ okLabel: "Restore" });
    expect(m.runSqlQuery).not.toHaveBeenCalled();
  });

  it("runs every statement in Default mode", async () => {
    await restore();
    expect(m.runSqlQuery).toHaveBeenCalledTimes(3);
    expect(m.touchId).not.toHaveBeenCalled();
    expect(m.showToast).toHaveBeenCalledWith("Database restored.", {
      tone: "success",
    });
  });

  it.each(["production", "lock"])(
    "refuses in %s mode before a file is chosen",
    async (mode) => {
      setMode(mode);
      await restore();
      expect(m.openDialog).not.toHaveBeenCalled();
      expect(m.runSqlQuery).not.toHaveBeenCalled();
      expect(m.showMessage).toHaveBeenCalledTimes(1);
    }
  );

  it("checks again after the confirmation: switched to Production meanwhile", async () => {
    m.confirmDialog.mockImplementation(async () => {
      setMode("production");
      return true;
    });
    await restore();
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(m.showMessage.mock.calls[0]![0]).toContain("Production mode");
  });

  it("asks for Touch ID in Safe mode and runs nothing without it", async () => {
    setMode("safe");
    m.touchId.mockRejectedValueOnce(new Error("cancelled"));
    await restore();
    expect(m.touchId).toHaveBeenCalledTimes(1);
    expect(m.runSqlQuery).not.toHaveBeenCalled();

    await restore();
    expect(m.touchId).toHaveBeenCalledTimes(2);
    expect(m.runSqlQuery).toHaveBeenCalledTimes(3);
  });

  it("says how many statements were skipped", async () => {
    m.runSqlQuery.mockRejectedValueOnce(
      new Error('relation "a" already exists')
    );
    await restore();
    expect(m.showToast).toHaveBeenCalledWith(
      expect.stringContaining("1 statement was skipped"),
      { tone: "info" }
    );
  });

  it("says what already ran when it stops partway", async () => {
    m.runSqlQuery
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("disk full"));
    await restore();
    const [message] = m.showMessage.mock.calls[0]!;
    expect(message).toContain("Stopped at statement 2 of 3: disk full");
    expect(message).toContain(
      "The statement before it already ran and stays in the database."
    );
  });
});

describe("the safety mode is read again while a dump runs", () => {
  it.each([
    ["locked", () => setMode("lock")],
    ["switched to Production", () => setMode("production")],
    ["closed", () => useScreenStore.setState({ profileTabs: [] })],
  ])("runs nothing when the tab is %s during Touch ID", async (_c, change) => {
    setMode("safe");
    m.touchId.mockImplementation(async () => {
      change();
      return true;
    });
    await restore();
    expect(m.touchId).toHaveBeenCalledTimes(1);
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(m.showMessage).toHaveBeenCalledTimes(1);
  });

  it("stops the remaining statements when the tab is locked mid-run", async () => {
    m.runSqlQuery.mockImplementationOnce(async () => {
      setMode("lock");
      return {};
    });
    const onRefresh = vi.fn();
    await restore(onRefresh);
    expect(m.runSqlQuery).toHaveBeenCalledTimes(1);
    // What already ran is shown.
    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    const [message] = m.showMessage.mock.calls[0]!;
    expect(message).toContain("so nothing more was restored");
    expect(message).toContain("Stopped before statement 2 of 3.");
    expect(message).toContain(
      "The statement before it already ran and stays in the database."
    );
    expect(m.showToast).not.toHaveBeenCalled();
  });

  it("asks for Touch ID when the tab turns Safe mid-run", async () => {
    m.runSqlQuery.mockImplementationOnce(async () => {
      setMode("safe");
      return {};
    });
    await restore();
    expect(m.touchId).toHaveBeenCalledTimes(1);
    expect(m.runSqlQuery).toHaveBeenCalledTimes(3);
  });

  it("applies the same checks to a table-level SQL dump import", async () => {
    m.runSqlQuery.mockImplementationOnce(async () => {
      setMode("production");
      return {};
    });
    const { result } = renderHook(() => useDatabaseBackup());
    await act(() => result.current.onImportSqlDump(undefined, { tabId: "t1" }));
    expect(m.runSqlQuery).toHaveBeenCalledTimes(1);
    expect(m.showMessage.mock.calls[0]![0]).toContain(
      "so nothing more was imported"
    );
  });
});

describe("database backup", () => {
  it("is offered only where it holds the table structure", () => {
    expect(canBackupDatabase("postgres")).toBe(true);
    expect(canBackupDatabase("mysql")).toBe(true);
    expect(canBackupDatabase("mariadb")).toBe(true);
    expect(canBackupDatabase("sqlite")).toBe(false);
    expect(canBackupDatabase("sqlserver")).toBe(false);
    expect(canBackupDatabase(undefined)).toBe(false);
  });

  it("is not offered where it would hold rows only", async () => {
    m.rt.engine = "sqlite";
    const { result } = renderHook(() => useDatabaseBackup());
    await act(() => result.current.onBackupDatabase("main"));
    expect(m.showMessage.mock.calls[0]![0]).toBe(
      "Database backup is available for PostgreSQL, MySQL and MariaDB."
    );
  });
});

describe("a stop before anything ran", () => {
  it("does not refresh when the tab is locked during Touch ID", async () => {
    setMode("safe");
    m.touchId.mockImplementation(async () => {
      setMode("lock");
      return true;
    });
    const onRefresh = vi.fn();
    await restore(onRefresh);
    expect(m.refresh).not.toHaveBeenCalled();
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
