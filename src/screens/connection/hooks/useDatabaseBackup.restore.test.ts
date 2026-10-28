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
  sessionBegin: vi.fn(),
  sessionEnd: vi.fn(),
  savepoints: vi.fn(),
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
// A PostgreSQL restore runs in a session; its statements still reach
// runSqlQuery here, savepoint bookkeeping goes to its own mock.
vi.mock("src/lib/tauri/sqlSession", () => ({
  sqlSessionBegin: m.sessionBegin,
  sqlSessionEnd: m.sessionEnd,
  sqlSessionExecute: async (_session: string, sql: string) =>
    /^(SAVEPOINT|RELEASE|ROLLBACK TO) /.test(sql)
      ? m.savepoints(sql)
      : m.runSqlQuery("conn_1", sql),
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

import {
  canBackupDatabase,
  isTransactionControl,
  restoreErrorSummary,
  restoreStatementLabel,
  useDatabaseBackup,
} from "./useDatabaseBackup";

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
  m.sessionBegin.mockResolvedValue({ sessionId: "s1", snapshotId: null });
  m.sessionEnd.mockResolvedValue(undefined);
  m.savepoints.mockResolvedValue(undefined);
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

  it("skips a type that already exists, after the dump's comment line", async () => {
    m.unpack.mockResolvedValue({
      sql: '-- Schemas and types\nCREATE TYPE "public"."user_role" AS ENUM (\'a\');\nINSERT INTO a VALUES (1);',
      engine: "postgres",
    });
    m.runSqlQuery.mockRejectedValueOnce(
      new Error('type "user_role" already exists')
    );
    await restore();
    expect(m.runSqlQuery).toHaveBeenCalledTimes(2);
    expect(m.showToast).toHaveBeenCalledWith(
      expect.stringContaining("1 statement was skipped"),
      { tone: "info" }
    );
  });

  it.each([
    // A type named "already exists" that is missing is not a duplicate.
    [
      'CREATE TABLE a (x "already exists")',
      'type "already exists" does not exist',
    ],
    // A CHECK whose name holds "already" fails on the data.
    [
      "ALTER TABLE a ADD CONSTRAINT already_positive CHECK (x > 0)",
      'check constraint "already_positive" of relation "a" is violated by some row',
    ],
    // A duplicate only in the DETAIL line is not the error itself.
    [
      "CREATE INDEX i ON a (missing)",
      'column "missing" does not exist\nDETAIL: something already exists',
    ],
  ])("stops on a real failure of %s", async (statement, error) => {
    m.unpack.mockResolvedValue({
      sql: `-- Structure public.a\n${statement};\nINSERT INTO a VALUES (1);`,
      engine: "postgres",
    });
    m.runSqlQuery.mockRejectedValueOnce(new Error(error));
    await restore();
    expect(m.runSqlQuery).toHaveBeenCalledTimes(1);
    expect(m.showMessage.mock.calls[0]![0]).toContain("Stopped at statement 1");
  });

  it("never splits data into statements of its own (PostgreSQL backslashes)", async () => {
    m.unpack.mockResolvedValue({
      sql: String.raw`INSERT INTO "public"."t" ("a","b") VALUES ('\', ';DROP TABLE victim;--');
INSERT INTO "public"."t" ("a","b") VALUES ('x', 'y');`,
      engine: "postgres",
    });
    await restore();
    const ran = m.runSqlQuery.mock.calls
      .map((call) => call[1] as string)
      // The check for tables that already have rows.
      .filter((sql) => !sql.startsWith("SELECT to_regclass"));
    expect(ran).toHaveLength(2);
    expect(ran.some((sql) => /^\s*DROP TABLE victim/i.test(sql))).toBe(false);
    expect(ran[0]).toContain(";DROP TABLE victim;--')");
  });

  it("keeps the stop message short: no row data, no long details", async () => {
    const rows = Array.from(
      { length: 200 },
      (_, i) => `('id-${i}', 'Customer ${i}', NULL)`
    ).join(", ");
    m.unpack.mockResolvedValue({
      sql: `-- Data public.products\n-- Data public.users\nINSERT INTO "public"."users" ("id", "name", "role") VALUES ${rows};`,
      engine: "postgres",
    });
    m.runSqlQuery.mockImplementation(async (_c: string, sql: string) => {
      if (!sql.includes("INSERT INTO")) return {};
      throw new Error(
        `null value in column "role" violates not-null constraint\nDETAIL: Failing row contains (${"x, ".repeat(300)}).\nHINT: check\nCONTEXT: more`
      );
    });
    await restore();
    const [message] = m.showMessage.mock.calls[0]!;
    expect(message).toContain(
      'Statement: INSERT INTO "public"."users" ("id", "name", "role") VALUES …'
    );
    expect(message).not.toContain("Customer 1");
    expect(message).not.toContain("-- Data");
    expect(message).not.toContain("CONTEXT");
    expect(message).toContain("HINT: check");
    expect(message.length).toBeLessThan(1_000);
  });

  it("refuses a dump that controls transactions, running nothing", async () => {
    m.unpack.mockResolvedValue({
      sql: "INSERT INTO a VALUES (1);\n-- note\nCOMMIT;\nINSERT INTO a VALUES (2);",
      engine: "postgres",
    });
    await restore();
    expect(m.sessionBegin).not.toHaveBeenCalled();
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(m.showMessage.mock.calls[0]![0]).toMatch(
      /^Statement 2 of 3 controls transactions .*nothing was run/
    );
  });

  it("keeps nothing when the tab is locked during the last statement", async () => {
    m.unpack.mockResolvedValue({
      sql: "INSERT INTO a VALUES (1);",
      engine: "postgres",
    });
    m.runSqlQuery.mockImplementationOnce(async () => {
      setMode("lock");
      return {};
    });
    await restore();
    expect(m.sessionEnd).toHaveBeenCalledWith("s1", false);
    expect(m.sessionEnd).not.toHaveBeenCalledWith("s1", true);
    expect(m.showMessage.mock.calls[0]![0]).toContain(
      "Stopped before committing."
    );
    expect(m.showToast).not.toHaveBeenCalled();
  });

  it("rolls a PostgreSQL run back when it stops partway", async () => {
    m.runSqlQuery
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("disk full"));
    await restore();
    const [message] = m.showMessage.mock.calls[0]!;
    expect(message).toContain("Stopped at statement 2 of 3: disk full");
    expect(message).toContain("Nothing was changed: the run was rolled back.");
    expect(m.sessionBegin).toHaveBeenCalledWith("conn_1", "transaction");
    expect(m.sessionEnd).toHaveBeenCalledWith("s1", false);
    expect(m.sessionEnd).not.toHaveBeenCalledWith("s1", true);
  });

  it("commits a PostgreSQL run that finishes, each statement behind a savepoint", async () => {
    await restore();
    expect(m.sessionEnd).toHaveBeenCalledWith("s1", true);
    expect(m.savepoints.mock.calls.map((call) => call[0])).toEqual(
      Array(3)
        .fill([
          "SAVEPOINT politedb_restore",
          "RELEASE SAVEPOINT politedb_restore",
        ])
        .flat()
    );
  });

  it("undoes a skipped statement alone, at its savepoint", async () => {
    m.runSqlQuery.mockRejectedValueOnce(
      new Error('relation "a" already exists')
    );
    await restore();
    expect(m.savepoints).toHaveBeenCalledWith(
      "ROLLBACK TO SAVEPOINT politedb_restore"
    );
    expect(m.sessionEnd).toHaveBeenCalledWith("s1", true);
  });

  it("says what already ran when a run without a transaction stops partway", async () => {
    m.rt.engine = "mysql";
    m.unpack.mockResolvedValue({ sql: DUMP, engine: "mysql" });
    m.runSqlQuery
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("disk full"));
    await restore();
    const [message] = m.showMessage.mock.calls[0]!;
    expect(message).toContain("Stopped at statement 2 of 3: disk full");
    expect(message).toContain(
      "The statement before it already ran and stays in the database."
    );
    expect(m.sessionBegin).not.toHaveBeenCalled();
  });

  it("warns before adding rows to tables that already have some", async () => {
    m.unpack.mockResolvedValue({
      sql: 'INSERT INTO "public"."t" ("a") VALUES (1);',
      engine: "postgres",
    });
    m.runSqlQuery.mockImplementation(async (_c: string, sql: string) =>
      sql.startsWith("SELECT to_regclass") || sql.startsWith("SELECT EXISTS")
        ? { rows: [[{ t: "Bool", v: true }]] }
        : {}
    );
    m.confirmDialog.mockResolvedValue(false);
    await restore();
    const [body] = m.confirmDialog.mock.calls[0]!;
    expect(body).toContain('These tables already have rows: "public"."t".');
    expect(body).toContain("They run in one transaction");
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
    // Rolled back: nothing changed, nothing to show.
    expect(m.sessionEnd).toHaveBeenCalledWith("s1", false);
    expect(m.refresh).not.toHaveBeenCalled();
    const [message] = m.showMessage.mock.calls[0]!;
    expect(message).toContain("so nothing was restored");
    expect(message).toContain("Stopped before statement 2 of 3.");
    expect(message).toContain("Nothing was changed: the run was rolled back.");
    expect(m.showToast).not.toHaveBeenCalled();
  });

  it("shows what already ran when a run without a transaction is locked mid-run", async () => {
    m.rt.engine = "mysql";
    m.unpack.mockResolvedValue({ sql: DUMP, engine: "mysql" });
    m.runSqlQuery.mockImplementationOnce(async () => {
      setMode("lock");
      return {};
    });
    const onRefresh = vi.fn();
    await restore(onRefresh);
    expect(m.refresh).toHaveBeenCalledTimes(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    const [message] = m.showMessage.mock.calls[0]!;
    expect(message).toContain("so nothing more was restored");
    expect(message).toContain(
      "The statement before it already ran and stays in the database."
    );
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
      "so nothing was imported"
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

describe("stop message parts", () => {
  it("labels a statement by its head, never its rows", () => {
    expect(
      restoreStatementLabel(
        "-- Structure public.a\r\n-- x\nCREATE TABLE a (id int)"
      )
    ).toBe("CREATE TABLE a (id int)");
    expect(
      restoreStatementLabel(
        "/* note */ -- x\nINSERT INTO t VALUES ('SECRET_ROW')"
      )
    ).toBe("INSERT INTO t VALUES …");
    expect(
      restoreStatementLabel(
        "INSERT INTO `db`.`t` (`a`, `b`) VALUES ('SECRET_ROW', 1)"
      )
    ).toBe("INSERT INTO `db`.`t` (`a`, `b`) VALUES …");
    expect(restoreStatementLabel("x".repeat(500)).length).toBeLessThanOrEqual(
      163
    );
    expect(restoreStatementLabel("-- Data public.t\n")).toBe("(comment only)");
  });

  it("keeps the message, DETAIL and HINT lines wherever they are", () => {
    const summary = restoreErrorSummary(
      new Error(
        `syntax error at or near "x"\r\nCONTEXT: ${"c".repeat(500)}\nDETAIL: d\nWHERE: w\nHINT: add a cast`
      )
    );
    expect(summary).toBe(
      'syntax error at or near "x"\nDETAIL: d\nHINT: add a cast\n…'
    );
    expect(restoreErrorSummary("plain text failure")).toBe(
      "plain text failure"
    );
  });

  it("stays bounded however many DETAIL and HINT lines there are", () => {
    const repeated = Array.from(
      { length: 1_000 },
      () => `DETAIL: ${"r".repeat(400)}`
    ).join("\n");
    const summary = restoreErrorSummary(
      new Error(
        `new row violates check\nDETAIL: Failing row contains (a\n${repeated}\nHINT: first hint\nHINT: second`
      )
    );
    expect(summary.length).toBeLessThan(1_000);
    expect(summary.split("\n")).toEqual([
      "new row violates check",
      "DETAIL: Failing row contains (a",
      "HINT: first hint",
      "…",
    ]);
  });

  it("cuts a long line in the middle, keeping its end", () => {
    const summary = restoreErrorSummary(
      new Error(`${"y".repeat(1_000)} the useful end`)
    );
    expect(summary.length).toBeLessThanOrEqual(305);
    expect(summary).toMatch(/^y+ … y+ the useful end$/);
  });

  it.each([[null], [undefined], [{ code: 1 }], [""], [new Error("  ")]])(
    "says the error is unknown for %o",
    (error) => {
      expect(restoreErrorSummary(error)).toBe("Unknown restore error");
    }
  );
});

describe("isTransactionControl", () => {
  it.each([
    "COMMIT",
    "commit prepared 'x'",
    "END",
    "BEGIN ISOLATION LEVEL SERIALIZABLE",
    "START TRANSACTION",
    "-- a\nROLLBACK",
    "/* x */ SAVEPOINT s",
    "RELEASE SAVEPOINT s",
    "ABORT",
    "PREPARE TRANSACTION 'x'",
    // Comments nest, and may sit between the words.
    "/* outer /* inner */ outer */ COMMIT",
    "PREPARE/**/TRANSACTION 'x'",
    "START /* a */ -- b\n TRANSACTION",
  ])("is true for %s", (sql) => {
    expect(isTransactionControl(sql)).toBe(true);
  });

  it.each([
    "INSERT INTO commits VALUES (1)",
    "CREATE TABLE endings (x int)",
    "SELECT 'COMMIT'",
    "PREPARE q AS SELECT 1",
    // A prepared statement named with non-ASCII letters.
    "PREPARE transactioné AS SELECT 1",
    "PREPARE transaction中文 AS SELECT 1",
  ])("is false for %s", (sql) => {
    expect(isTransactionControl(sql)).toBe(false);
  });
});
