import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDumpJobStore, type DumpOutcome } from "src/stores/dumpJob";
import { useScreenStore } from "src/stores/screen";
import {
  cancelDumpJob,
  decideDumpJobStop,
  giveUpDumpJobCleanup,
  setDumpProgressScheduler,
  startDumpJob,
  type DumpJobHandle,
} from "./dumpJobController";

/**
 * The runners' cancel paths, driven step by step: what Cancel does at each
 * boundary, and what the outcome then says. Backends are mocks.
 */

const m = vi.hoisted(() => ({
  /** Catalog queries settle as if their cancel had been refused. */
  catalogCancelRejected: false,
  confirm: vi.fn(),
  unpack: vi.fn(),
  pack: vi.fn(),
  runSqlQuery: vi.fn(),
  begin: vi.fn(),
  execute: vi.fn(),
  end: vi.fn(),
  cancelSession: vi.fn(),
  statement: vi.fn(),
  stream: vi.fn(),
  fileBegin: vi.fn(),
  fileWrite: vi.fn(),
  filePublish: vi.fn(),
  fileAbort: vi.fn(),
  fileForget: vi.fn(),
}));

vi.mock("src/lib/system-dialog", () => ({ confirmDialog: m.confirm }));
vi.mock("src/lib/system-fs", () => ({
  readFile: async () => new Uint8Array(),
}));
vi.mock("src/lib/dump/politedbDumbFormat", () => ({
  unpackDumpBytes: m.unpack,
  packSqlToDumb: m.pack,
}));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: m.runSqlQuery }));
vi.mock("src/lib/tauri/sqlSession", () => ({
  sqlSessionBegin: m.begin,
  sqlSessionExecute: m.execute,
  sqlSessionEnd: m.end,
  sqlSessionCancel: m.cancelSession,
}));
vi.mock("src/lib/tauri/dumpOperation", () => ({
  dumpQuery: (c: string, sql: string, o: unknown) => {
    const result = Promise.resolve().then(() =>
      m.runSqlQuery(c, sql, { viaDumpPort: true, ...(o as object) })
    );
    return {
      result,
      cancel: async () => ({ kind: "requested" }),
      settled: result.then(
        () =>
          m.catalogCancelRejected
            ? { kind: "client-disposed", cancelRejected: true }
            : { kind: "server-finished" },
        (error: unknown) => ({ kind: "server-finished", error })
      ),
    };
  },
  dumpStatement: m.statement,
  dumpStream: m.stream,
}));
vi.mock("src/lib/tauri/backupFile", () => ({
  BACKUP_FILE_ALREADY_PUBLISHED: "BACKUP_FILE_ALREADY_PUBLISHED",
  BACKUP_FILE_TEMP_NOT_REMOVED: "BACKUP_FILE_TEMP_NOT_REMOVED",
  backupFileBegin: m.fileBegin,
  backupFileWrite: m.fileWrite,
  backupFilePublish: m.filePublish,
  backupFileAbort: m.fileAbort,
  backupFileForget: m.fileForget,
}));
vi.mock("src/lib/tauri/security", () => ({
  securityTouchIdAuthenticate: vi.fn(),
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { runDumpImport, SEQUENCE_NOTE } from "./restoreRun";
import { runDatabaseBackup } from "./backupRun";

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

const DUMP =
  "CREATE TABLE a (id int);\nINSERT INTO a VALUES (1);\nINSERT INTO a VALUES (2);";

const refresh = vi.fn(async () => {});

function job(kind: "restore" | "backup", engine: string): DumpJobHandle {
  const started = startDumpJob(kind, {
    tabId: "t1",
    runtimeConnectionId: "c1",
    engine,
    target: "shop",
  });
  if (!started.ok) throw new Error(started.message);
  return started.job;
}

function restore(engine: string, j: DumpJobHandle) {
  return runDumpImport(
    {
      runtimeConnectionId: "c1",
      engine: engine as never,
      refreshSchemaAndTables: refresh,
    },
    "/backups/shop.dumb",
    {
      action: "restore",
      dialogTitle: "Restore",
      successToast: "Database restored.",
      tabId: "t1",
    },
    j,
    undefined
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  m.catalogCancelRejected = false;
  useDumpJobStore.setState({ active: null, summary: null, closing: [] });
  useScreenStore.setState({
    profileTabs: [
      {
        id: "t1",
        profileId: "p1",
        label: "shop",
        querySafetyMode: "default",
        runtimeConnectionId: "c1",
      },
    ] as never,
  });
  setDumpProgressScheduler((f) => f());
  m.confirm.mockResolvedValue(true);
  m.unpack.mockResolvedValue({ sql: DUMP, engine: null });
  m.runSqlQuery.mockResolvedValue({ rows: [] });
  m.begin.mockResolvedValue({ sessionId: "s1", snapshotId: null });
  m.execute.mockResolvedValue(undefined);
  m.end.mockResolvedValue(undefined);
  m.cancelSession.mockResolvedValue("cancelled");
});

/** A PostgreSQL statement that runs until released (or the session closes). */
function holdStatement(text: string) {
  const held = deferred();
  m.execute.mockImplementation(async (_s: string, sql: string) => {
    if (sql === text) await held.promise;
  });
  return held;
}

describe("PostgreSQL restore cancel", () => {
  it("closes the session: nothing committed, and says what a rollback leaves", async () => {
    const held = holdStatement("INSERT INTO a VALUES (1)");
    m.cancelSession.mockImplementation(async () => {
      held.reject(new Error("SQL_SESSION_ENDED"));
      return "cancelled";
    });
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await flush();
    cancelDumpJob(j.jobId);
    const outcome = await run;
    expect(m.cancelSession).toHaveBeenCalledWith("s1");
    expect(m.end).not.toHaveBeenCalledWith("s1", true);
    expect(outcome).toMatchObject({
      kind: "cancelled",
      rollback: "not-committed-closed",
    });
    expect((outcome as { message: string }).message).toContain(
      "The transaction was not committed."
    );
    expect((outcome as { message: string }).message).toContain(SEQUENCE_NOTE);
  });

  it("falls back to ROLLBACK when the cancel call fails", async () => {
    const held = holdStatement("INSERT INTO a VALUES (1)");
    m.cancelSession.mockRejectedValue(new Error("ipc down"));
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await flush();
    cancelDumpJob(j.jobId);
    await flush();
    // The statement finishes; no further statement starts.
    held.resolve();
    const outcome = await run;
    expect(m.end).toHaveBeenCalledWith("s1", false);
    expect(m.end).not.toHaveBeenCalledWith("s1", true);
    expect(m.execute).not.toHaveBeenCalledWith(
      "s1",
      "INSERT INTO a VALUES (2)"
    );
    expect(outcome).toMatchObject({
      kind: "cancelled",
      rollback: "rolled-back",
    });
  });

  it("offers retries when nothing could close it, and says so on Stop trying", async () => {
    const held = holdStatement("INSERT INTO a VALUES (1)");
    m.cancelSession.mockRejectedValue(new Error("ipc down"));
    m.end.mockRejectedValue(new Error("ipc down"));
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await flush();
    cancelDumpJob(j.jobId);
    await flush();
    held.resolve();
    await vi.waitFor(() =>
      expect(useDumpJobStore.getState().active?.cancel.kind).toBe("failed")
    );
    // Retry (Cancel again): still failing, offered again; then give up.
    cancelDumpJob(j.jobId);
    await vi.waitFor(() => expect(m.cancelSession).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(useDumpJobStore.getState().active?.cancel.kind).toBe("failed")
    );
    giveUpDumpJobCleanup(j.jobId);
    const outcome = await run;
    expect(outcome).toMatchObject({
      kind: "cancelled",
      rollback: "cleanup-unconfirmed",
    });
    expect((outcome as { message: string }).message).toContain(
      "closing its connection could not be confirmed"
    );
  });

  it("a retry that closes the session gives its evidence", async () => {
    const held = holdStatement("INSERT INTO a VALUES (1)");
    m.cancelSession
      .mockRejectedValueOnce(new Error("ipc down"))
      .mockResolvedValue("cancelled");
    m.end.mockRejectedValue(new Error("ipc down"));
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await flush();
    cancelDumpJob(j.jobId);
    await flush();
    held.resolve();
    await vi.waitFor(() =>
      expect(useDumpJobStore.getState().active?.cancel.kind).toBe("failed")
    );
    cancelDumpJob(j.jobId);
    expect(await run).toMatchObject({
      kind: "cancelled",
      rollback: "not-committed-closed",
    });
  });

  it("cancels a session that opens after the cancel", async () => {
    const opened = deferred<{ sessionId: string; snapshotId: null }>();
    m.begin.mockReturnValue(opened.promise);
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await flush();
    cancelDumpJob(j.jobId);
    await flush();
    opened.resolve({ sessionId: "late", snapshotId: null });
    const outcome = await run;
    expect(m.cancelSession).toHaveBeenCalledWith("late");
    expect(m.execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({
      kind: "cancelled",
      rollback: "not-committed-closed",
    });
  });

  it("cannot be cancelled once COMMIT is sent", async () => {
    const committing = deferred();
    m.end.mockImplementation(async (_s: string, commit: boolean) => {
      if (commit) await committing.promise;
    });
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await vi.waitFor(() =>
      expect(useDumpJobStore.getState().active?.phase).toBe("committing")
    );
    expect(useDumpJobStore.getState().active?.cancellable).toBe(false);
    cancelDumpJob(j.jobId);
    expect(m.cancelSession).not.toHaveBeenCalled();
    committing.resolve();
    expect(await run).toEqual({ kind: "succeeded", skipped: 0 });
    expect(refresh).toHaveBeenCalled();
  });

  it("reports a COMMIT without answer as unknown, and refreshes", async () => {
    m.end.mockImplementation(async (_s: string, commit: boolean) => {
      if (commit)
        throw new Error(
          "The connection closed while committing, so whether the changes were applied is unknown."
        );
    });
    const j = job("restore", "postgres");
    expect(await restore("postgres", j)).toMatchObject({
      kind: "commit-unknown",
    });
    expect(refresh).toHaveBeenCalled();
  });

  it("says a committed restore was committed when only the refresh failed", async () => {
    refresh.mockRejectedValueOnce(new Error("schema gone"));
    const j = job("restore", "postgres");
    const outcome = await restore("postgres", j);
    expect(outcome.kind).toBe("committed-refresh-failed");
    expect((outcome as { message: string }).message).toContain("was committed");
  });
});

/** A statement outside a transaction, settled as the test says. */
function statementOp(settled: Promise<{ kind: string; error?: unknown }>) {
  return { result: settled, cancel: vi.fn(), settled };
}

describe("statement-by-statement cancel (MySQL)", () => {
  beforeEach(() => {
    m.unpack.mockResolvedValue({ sql: DUMP, engine: "mysql" });
    m.statement.mockImplementation(() =>
      statementOp(Promise.resolve({ kind: "server-finished" }))
    );
  });

  it("lets the running statement finish, then asks with settled counts", async () => {
    const first = deferred<{ kind: string }>();
    m.statement
      .mockImplementationOnce(() => statementOp(first.promise))
      .mockImplementation(() =>
        statementOp(Promise.resolve({ kind: "server-finished" }))
      );
    const j = job("restore", "mysql");
    const run = restore("mysql", j);
    await flush();
    cancelDumpJob(j.jobId);
    cancelDumpJob(j.jobId);
    await flush();
    // No question while the statement still runs.
    expect(useDumpJobStore.getState().active?.stopDecision).toBeNull();
    first.resolve({ kind: "server-finished" });
    await vi.waitFor(() =>
      expect(useDumpJobStore.getState().active?.stopDecision).not.toBeNull()
    );
    const decision = useDumpJobStore.getState().active!.stopDecision!;
    expect(decision.counts).toMatchObject({ completed: 1, total: 3 });
    expect(m.statement).toHaveBeenCalledTimes(1);
    decideDumpJobStop(j.jobId, decision.decisionId, true);
    const outcome = await run;
    expect(outcome).toMatchObject({
      kind: "stopped",
      reason: "user",
      counts: { completed: 1 },
    });
    expect((outcome as { message: string }).message).toContain(
      "Stopped before statement 2 of 3."
    );
    expect(refresh).toHaveBeenCalled();
  });

  it("continues when the user says so, and can be asked again", async () => {
    const first = deferred<{ kind: string }>();
    m.statement
      .mockImplementationOnce(() => statementOp(first.promise))
      .mockImplementation(() =>
        statementOp(Promise.resolve({ kind: "server-finished" }))
      );
    const j = job("restore", "mysql");
    const run = restore("mysql", j);
    await flush();
    cancelDumpJob(j.jobId);
    first.resolve({ kind: "server-finished" });
    await vi.waitFor(() =>
      expect(useDumpJobStore.getState().active?.stopDecision).not.toBeNull()
    );
    const { decisionId } = useDumpJobStore.getState().active!.stopDecision!;
    decideDumpJobStop(j.jobId, decisionId, false);
    expect(await run).toEqual({ kind: "succeeded", skipped: 0 });
    expect(m.statement).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["stops with final counts", true, "server-finished", false],
    ["continues to the end", false, "server-finished", false],
    ["counts a skipped last statement", true, "skipped", true],
  ])(
    "asks after the last statement too, then %s",
    async (_name, stop, lastKind, lastSkipped) => {
      const last = deferred<{ kind: string; error?: unknown }>();
      m.statement
        .mockImplementationOnce(() =>
          statementOp(Promise.resolve({ kind: "server-finished" }))
        )
        .mockImplementationOnce(() =>
          statementOp(Promise.resolve({ kind: "server-finished" }))
        )
        .mockImplementationOnce(() => statementOp(last.promise));
      if (lastSkipped) {
        // A last statement that may be skipped (its table exists).
        m.unpack.mockResolvedValue({
          sql: "INSERT INTO a VALUES (1);\nINSERT INTO a VALUES (2);\nCREATE TABLE b (id int);",
          engine: "mysql",
        });
      }
      const j = job("restore", "mysql");
      const run = restore("mysql", j);
      await vi.waitFor(() => expect(m.statement).toHaveBeenCalledTimes(3));
      cancelDumpJob(j.jobId);
      last.resolve(
        lastKind === "skipped"
          ? {
              kind: "server-finished",
              error: new Error("Table 'b' already exists"),
            }
          : { kind: "server-finished" }
      );
      await vi.waitFor(() =>
        expect(useDumpJobStore.getState().active?.stopDecision).not.toBeNull()
      );
      const decision = useDumpJobStore.getState().active!.stopDecision!;
      expect(decision.counts).toMatchObject({
        completed: lastSkipped ? 2 : 3,
        skipped: lastSkipped ? 1 : 0,
        total: 3,
      });
      decideDumpJobStop(j.jobId, decision.decisionId, stop);
      const outcome = await run;
      if (!stop) {
        expect(outcome).toEqual({
          kind: "succeeded",
          skipped: lastSkipped ? 1 : 0,
        });
        return;
      }
      expect(outcome).toMatchObject({ kind: "stopped", reason: "user" });
      const message = (outcome as { message: string }).message;
      expect(message).toContain("Stopped after the last statement.");
      expect(message).toContain(
        lastSkipped
          ? "2 of 3 statements ran and stay in the database, 1 skipped."
          : "3 of 3 statements ran and stay in the database."
      );
    }
  );

  it("stops at a timed-out statement, counted as unknown, and refreshes", async () => {
    m.statement.mockImplementationOnce(() =>
      statementOp(
        Promise.resolve({
          kind: "client-disposed",
          error: new Error("SQL_QUERY_TIMEOUT"),
        })
      )
    );
    const j = job("restore", "mysql");
    const outcome = await restore("mysql", j);
    expect(outcome).toMatchObject({
      kind: "failed",
      counts: { completed: 0, unknown: 1 },
    });
    expect((outcome as { message: string }).message).toContain(
      "may still be running on the server or be partly applied"
    );
    expect(m.statement).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalled();
  });
});

describe("backup cancel and file outcomes", () => {
  const rt = {
    runtimeConnectionId: "c1",
    engine: "mysql" as never,
    metaKey: "meta",
    metadata: {
      load: async () => ({
        tables: [{ schema: "shop", name: "t", kind: "table" }],
        columnsByTable: { "shop.t": ["id"] },
      }),
    } as never,
  };

  beforeEach(() => {
    m.runSqlQuery.mockImplementation(async (_c: string, sql: string) =>
      sql.startsWith("SHOW CREATE TABLE")
        ? {
            rows: [
              [
                { t: "Str", v: "t" },
                { t: "Str", v: "CREATE TABLE t (id int)" },
              ],
            ],
          }
        : { rows: [] }
    );
    m.pack.mockImplementation(async () => new Uint8Array([1, 2, 3]));
    m.fileBegin.mockResolvedValue("f1");
    m.fileWrite.mockResolvedValue(undefined);
    m.filePublish.mockResolvedValue(undefined);
    m.fileAbort.mockResolvedValue(undefined);
    m.stream.mockImplementation(() => {
      const settled = Promise.resolve({ kind: "server-finished" });
      return { result: settled, cancel: vi.fn(), settled };
    });
  });

  it("writes and publishes a backup", async () => {
    const j = job("backup", "mysql");
    expect(await runDatabaseBackup(rt, "/out.dumb", j)).toEqual({
      kind: "succeeded",
      skipped: 0,
    });
    expect(m.fileBegin).toHaveBeenCalledWith("/out.dumb");
    expect(m.fileWrite).toHaveBeenCalledWith("f1", new Uint8Array([1, 2, 3]));
    expect(m.filePublish).toHaveBeenCalledWith("f1");
    // Every catalog query goes through the owned dump port (no analytics,
    // stopped and joined by the job's cleanup).
    expect(m.runSqlQuery.mock.calls.length).toBeGreaterThan(0);
    for (const call of m.runSqlQuery.mock.calls) {
      expect(call[2]).toMatchObject({ viaDumpPort: true });
    }
  });

  it("stops the row stream on cancel and writes nothing", async () => {
    const settled = deferred<{ kind: string; error?: unknown }>();
    const cancel = vi.fn(async () => {
      settled.resolve({ kind: "client-disposed", error: new Error("Abort") });
      return { kind: "requested" };
    });
    m.stream.mockImplementation(() => ({
      result: settled.promise,
      cancel,
      settled: settled.promise,
    }));
    const j = job("backup", "mysql");
    const run = runDatabaseBackup(rt, "/out.dumb", j);
    await vi.waitFor(() => expect(m.stream).toHaveBeenCalled());
    cancelDumpJob(j.jobId);
    const outcome: DumpOutcome = await run;
    expect(cancel).toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "cancelled" });
    expect(m.pack).not.toHaveBeenCalled();
    expect(m.fileBegin).not.toHaveBeenCalled();
  });

  it("waits for compression, then writes nothing", async () => {
    const packed = deferred<Uint8Array>();
    m.pack.mockReturnValue(packed.promise);
    const j = job("backup", "mysql");
    const run = runDatabaseBackup(rt, "/out.dumb", j);
    await vi.waitFor(() =>
      expect(useDumpJobStore.getState().active?.phase).toBe("compressing")
    );
    cancelDumpJob(j.jobId);
    await flush();
    expect(useDumpJobStore.getState().active?.cancel.kind).toBe("accepted");
    packed.resolve(new Uint8Array([9]));
    expect(await run).toMatchObject({ kind: "cancelled" });
    expect(m.fileBegin).not.toHaveBeenCalled();
  });

  it("counts a published file whose reply was lost as written", async () => {
    m.filePublish.mockRejectedValue(new Error("ipc down"));
    m.fileAbort.mockRejectedValue(new Error("BACKUP_FILE_ALREADY_PUBLISHED"));
    const j = job("backup", "mysql");
    expect(await runDatabaseBackup(rt, "/out.dumb", j)).toEqual({
      kind: "succeeded",
      skipped: 0,
    });
  });

  it("says a temp could not be removed, and lets it go", async () => {
    m.fileWrite.mockRejectedValue(new Error("BACKUP_FILE_WRITE_FAILED"));
    m.fileAbort.mockRejectedValue(new Error("BACKUP_FILE_TEMP_NOT_REMOVED"));
    m.fileForget.mockResolvedValue(undefined);
    const j = job("backup", "mysql");
    expect(await runDatabaseBackup(rt, "/out.dumb", j)).toMatchObject({
      kind: "temp-not-removed",
      after: "failed",
    });
    expect(m.fileAbort).toHaveBeenCalledTimes(2);
    expect(m.fileForget).toHaveBeenCalledWith("f1");
    expect(m.filePublish).not.toHaveBeenCalled();
  });

  it("says the file's status is unknown when neither step answers", async () => {
    m.filePublish.mockRejectedValue(new Error("ipc down"));
    m.fileAbort.mockRejectedValue(new Error("ipc down"));
    const j = job("backup", "mysql");
    expect(await runDatabaseBackup(rt, "/out.dumb", j)).toEqual({
      kind: "file-unconfirmed",
    });
  });
});

describe("Codex Phase 2 review cases", () => {
  it.each([
    ["ERROR: deferred constraint violated", "failed", "rolled-back"],
    ["SQL_SESSION_END_TIMEOUT", "failed", "not-committed-closed"],
    ["SQL_SESSION_ENDED", "failed", "cleanup-unconfirmed"],
    ["SQL_SESSION_NOT_FOUND", "failed", "cleanup-unconfirmed"],
    ["ipc reply lost", "commit-unknown", undefined],
  ])(
    "a COMMIT rejected with %s is reported by what it proves",
    async (error, kind, rollback) => {
      m.end.mockImplementation(async (_s: string, commit: boolean) => {
        if (commit) throw new Error(error);
      });
      const j = job("restore", "postgres");
      const outcome = await restore("postgres", j);
      expect(outcome.kind).toBe(kind);
      if (rollback) expect(outcome).toMatchObject({ rollback });
      const message = (outcome as { message: string }).message;
      if (kind === "commit-unknown") {
        expect(message).toContain(
          "whether its changes were applied is unknown"
        );
        expect(message).not.toContain("rolled back");
      }
    }
  );

  it("reports a failure that came after a cancel that did not close the session", async () => {
    const held = holdStatement("INSERT INTO a VALUES (1)");
    m.cancelSession.mockRejectedValue(new Error("ipc down"));
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await flush();
    cancelDumpJob(j.jobId);
    await flush();
    held.reject(new Error("ERROR: duplicate key value"));
    const outcome = await run;
    expect(outcome).toMatchObject({
      kind: "cancelled",
      rollback: "rolled-back",
    });
    expect((outcome as { failure?: string }).failure).toContain(
      "duplicate key value"
    );
    expect((outcome as { message: string }).message).toContain(
      "Also: ERROR: duplicate key value"
    );
  });

  it("starts no catalog query once cancelled, and joins those running", async () => {
    // A constraint check per statement: the first is held.
    m.unpack.mockResolvedValue({
      sql: 'ALTER TABLE "public"."a" ADD CONSTRAINT "a_pk" PRIMARY KEY (id);\nALTER TABLE "public"."b" ADD CONSTRAINT "b_pk" PRIMARY KEY (id);',
      engine: null,
    });
    const checked = deferred<{ rows: unknown[][] }>();
    m.runSqlQuery.mockImplementation(async (_c: string, sql: string) =>
      sql.includes("pg_constraint") ? checked.promise : { rows: [] }
    );
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await vi.waitFor(() =>
      expect(
        m.runSqlQuery.mock.calls.filter((c) =>
          String(c[1]).includes("pg_constraint")
        )
      ).toHaveLength(1)
    );
    cancelDumpJob(j.jobId);
    await flush();
    checked.resolve({ rows: [] });
    const outcome = await run;
    expect(outcome.kind).toBe("cancelled");
    expect(
      m.runSqlQuery.mock.calls.filter((c) =>
        String(c[1]).includes("pg_constraint")
      )
    ).toHaveLength(1);
    expect(m.execute).not.toHaveBeenCalledWith(
      "s1",
      expect.stringContaining("ADD CONSTRAINT")
    );
  });

  it("a late prompt result is dropped once a close of the tab was admitted", async () => {
    const answer = deferred<boolean>();
    m.confirm.mockReturnValue(answer.promise);
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await vi.waitFor(() => expect(m.confirm).toHaveBeenCalled());
    const { admitClose } = await import("src/stores/dumpJob");
    // The job is active: closing its tab is refused…
    expect(admitClose({ kind: "tab", tabId: "t1" }).ok).toBe(false);
    // …but its runtime may be replaced meanwhile (reconnect).
    useScreenStore.setState({
      profileTabs: [
        { id: "t1", profileId: "p1", runtimeConnectionId: "c2" },
      ] as never,
    });
    answer.resolve(true);
    expect(await run).toEqual({ kind: "abandoned" });
    expect(m.begin).not.toHaveBeenCalled();
  });
});

describe("backup cleanup evidence (Codex Phase 2 review)", () => {
  const rt = {
    runtimeConnectionId: "c1",
    engine: "mysql" as never,
    metaKey: "meta",
    metadata: {
      load: async () => ({
        tables: [{ schema: "shop", name: "t", kind: "table" }],
        columnsByTable: { "shop.t": ["id"] },
      }),
    } as never,
  };
  const pgRt = { ...rt, engine: "postgres" as never };

  beforeEach(() => {
    m.runSqlQuery.mockImplementation(async (_c: string, sql: string) => {
      if (sql.startsWith("SHOW CREATE TABLE"))
        return {
          rows: [
            [
              { t: "Str", v: "t" },
              { t: "Str", v: "CREATE TABLE t (id int)" },
            ],
          ],
        };
      if (sql.includes("SELECT n.nspname, c.relname"))
        return {
          rows: [
            [
              { t: "Str", v: "public" },
              { t: "Str", v: "t" },
            ],
          ],
        };
      if (sql.includes("SELECT a.attname") && !sql.includes("walk"))
        return { rows: [[{ t: "Str", v: "id" }]] };
      return { rows: [] };
    });
    m.begin.mockResolvedValue({ sessionId: "snap", snapshotId: "0000-1" });
    m.pack.mockImplementation(async () => new Uint8Array([1]));
    m.fileBegin.mockResolvedValue("f1");
    m.fileWrite.mockResolvedValue(undefined);
    m.filePublish.mockResolvedValue(undefined);
    m.fileAbort.mockResolvedValue(undefined);
    m.stream.mockImplementation(() => {
      const settled = Promise.resolve({ kind: "server-finished" });
      return { result: settled, cancel: vi.fn(), settled };
    });
  });

  it("a stream whose backend cancel is rejected is not a confirmed cancel", async () => {
    const settled = deferred<{ kind: string; error?: unknown }>();
    m.stream.mockImplementation(() => ({
      result: settled.promise,
      cancel: async () => {
        settled.resolve({
          kind: "client-disposed",
          error: new Error("AbortError"),
        });
        return { kind: "rejected", error: new Error("ipc down") };
      },
      settled: settled.promise,
    }));
    const j = job("backup", "mysql");
    const run = runDatabaseBackup(rt, "/out.dumb", j);
    await vi.waitFor(() => expect(m.stream).toHaveBeenCalled());
    cancelDumpJob(j.jobId);
    const outcome = await run;
    expect(outcome).toMatchObject({
      kind: "cancelled",
      rollback: "cleanup-unconfirmed",
    });
    expect((outcome as { message: string }).message).toContain(
      "could not be confirmed closed"
    );
    expect(m.fileBegin).not.toHaveBeenCalled();
  });

  it("keeps the snapshot session until it is confirmed ended, and says so if never", async () => {
    m.end.mockRejectedValue(new Error("ipc down"));
    const j = job("backup", "postgres");
    const outcome = await runDatabaseBackup(pgRt, "/out.dumb", j);
    expect(m.end).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ kind: "succeeded" });
    expect((outcome as { warning?: string }).warning).toContain(
      "could not be confirmed closed"
    );
  });

  it("starts no compression after a cancel asked while the snapshot ends", async () => {
    const ending = deferred<void>();
    m.end.mockReturnValue(ending.promise);
    const j = job("backup", "postgres");
    const run = runDatabaseBackup(pgRt, "/out.dumb", j);
    await vi.waitFor(() => expect(m.end).toHaveBeenCalled());
    cancelDumpJob(j.jobId);
    ending.resolve();
    expect(await run).toMatchObject({ kind: "cancelled" });
    expect(m.pack).not.toHaveBeenCalled();
    expect(m.fileBegin).not.toHaveBeenCalled();
  });

  it("reports a row failure that came after the cancel", async () => {
    const settled = deferred<{ kind: string; error?: unknown }>();
    m.stream.mockImplementation(() => ({
      result: settled.promise,
      cancel: async () => {
        settled.resolve({
          kind: "client-disposed",
          error: new Error("permission denied for table t"),
        });
        return { kind: "requested" };
      },
      settled: settled.promise,
    }));
    const j = job("backup", "mysql");
    const run = runDatabaseBackup(rt, "/out.dumb", j);
    await vi.waitFor(() => expect(m.stream).toHaveBeenCalled());
    cancelDumpJob(j.jobId);
    const outcome = await run;
    expect(outcome).toMatchObject({
      kind: "cancelled",
      failure: "permission denied for table t",
    });
  });
});

describe("Codex Phase 2 review round 2 cases", () => {
  it("reports an independent catalog failure even when the cancel closed the session", async () => {
    m.unpack.mockResolvedValue({
      sql: 'ALTER TABLE "public"."a" ADD CONSTRAINT "a_pk" PRIMARY KEY (id);',
      engine: null,
    });
    const checked = deferred<{ rows: unknown[][] }>();
    m.runSqlQuery.mockImplementation(async (_c: string, sql: string) =>
      sql.includes("pg_constraint") ? checked.promise : { rows: [] }
    );
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await vi.waitFor(() =>
      expect(
        m.runSqlQuery.mock.calls.some((c) =>
          String(c[1]).includes("pg_constraint")
        )
      ).toBe(true)
    );
    cancelDumpJob(j.jobId);
    await flush();
    checked.reject(new Error("permission denied for table pg_constraint"));
    const outcome = await run;
    expect(outcome).toMatchObject({
      kind: "cancelled",
      rollback: "not-committed-closed",
    });
    expect((outcome as { failure?: string }).failure).toContain(
      "permission denied for table pg_constraint"
    );
  });

  it("reports an independent statement error even when the cancel closed the session", async () => {
    const held = holdStatement("INSERT INTO a VALUES (1)");
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await flush();
    cancelDumpJob(j.jobId);
    held.reject(new Error("ERROR: division by zero"));
    const outcome = await run;
    expect(outcome).toMatchObject({
      kind: "cancelled",
      rollback: "not-committed-closed",
    });
    expect((outcome as { message: string }).message).toContain(
      "Also: ERROR: division by zero"
    );
  });

  it.each([
    "SQL_SESSION_ENDED",
    "ERROR: connection closed",
    "ERROR: canceling statement due to user request",
  ])("leaves out %s, which the closing session causes", async (error) => {
    const held = holdStatement("INSERT INTO a VALUES (1)");
    const j = job("restore", "postgres");
    const run = restore("postgres", j);
    await flush();
    cancelDumpJob(j.jobId);
    held.reject(new Error(error));
    const outcome = await run;
    expect(outcome).toMatchObject({ kind: "cancelled" });
    expect((outcome as { failure?: string }).failure).toBeUndefined();
  });

  it("warns when a backup's catalog query could not be confirmed released", async () => {
    m.runSqlQuery.mockImplementation(async (_c: string, sql: string) =>
      sql.startsWith("SHOW CREATE TABLE")
        ? {
            rows: [
              [
                { t: "Str", v: "t" },
                { t: "Str", v: "CREATE TABLE t (id int)" },
              ],
            ],
          }
        : { rows: [] }
    );
    m.catalogCancelRejected = true;
    m.pack.mockImplementation(async () => new Uint8Array([1]));
    m.fileBegin.mockResolvedValue("f1");
    m.fileWrite.mockResolvedValue(undefined);
    m.filePublish.mockResolvedValue(undefined);
    m.stream.mockImplementation(() => {
      const settled = Promise.resolve({ kind: "server-finished" });
      return { result: settled, cancel: vi.fn(), settled };
    });
    const j = job("backup", "mysql");
    const outcome = await runDatabaseBackup(
      {
        runtimeConnectionId: "c1",
        engine: "mysql" as never,
        metaKey: "meta",
        metadata: {
          load: async () => ({
            tables: [{ schema: "shop", name: "t", kind: "table" }],
            columnsByTable: { "shop.t": ["id"] },
          }),
        } as never,
      },
      "/out.dumb",
      j
    );
    expect(outcome).toMatchObject({ kind: "succeeded" });
    expect((outcome as { warning?: string }).warning).toContain(
      "could not be confirmed closed"
    );
  });
});
