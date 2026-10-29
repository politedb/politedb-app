import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenStore } from "src/stores/screen";
import {
  dismissDumpJobSummary,
  DUMP_JOB_RUNNING_MESSAGE,
  useDumpJobStore,
} from "src/stores/dumpJob";

const m = vi.hoisted(() => ({
  saveDialog: vi.fn(),
  showMessage: vi.fn(),
  writeFile: vi.fn(),
  pack: vi.fn(),
  runSqlQuery: vi.fn(),
  startSqlQueryStream: vi.fn(),
  subscribe: vi.fn(),
  cancel: vi.fn(),
  sessionBegin: vi.fn(),
  sessionEnd: vi.fn(),
}));

vi.mock("src/lib/system-dialog", () => ({
  saveDialog: m.saveDialog,
  openDialog: vi.fn(),
  showMessage: m.showMessage,
  confirmDialog: vi.fn(),
}));
vi.mock("src/lib/system-fs", () => ({
  writeFile: m.writeFile,
  readFile: vi.fn(),
}));
vi.mock("src/lib/dump/politedbDumbFormat", () => ({
  packSqlToDumb: m.pack,
  unpackDumpBytes: vi.fn(),
}));
// Catalog queries go through the dump port; here they reach runSqlQuery.
vi.mock("src/lib/tauri/dumpOperation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/lib/tauri/dumpOperation")>();
  return {
    ...actual,
    dumpQuery: (c: string, sql: string, o: unknown) => {
      const result = Promise.resolve().then(() => m.runSqlQuery(c, sql, o));
      return {
        result,
        cancel: async () => ({ kind: "requested" }),
        settled: result.then(
          () => ({ kind: "server-finished" }),
          (error: unknown) => ({ kind: "server-finished", error })
        ),
      };
    },
  };
});
vi.mock("src/lib/tauri/query", () => ({
  startSqlQueryStream: m.startSqlQueryStream,
  runSqlQuery: m.runSqlQuery,
  // The dump port starts its operations here: reported as the stream
  // start, with the same options.
  operationExecuteWithBusyRetry: (input: {
    connection_id: string;
    sql: {
      sql: string;
      batch_size?: number;
      max_rows?: number;
      canonical_text_output?: boolean;
      snapshot_id?: string;
    };
  }) =>
    m.startSqlQueryStream(input.connection_id, input.sql.sql, {
      batchSize: input.sql.batch_size,
      maxRows: input.sql.max_rows,
      canonicalTextOutput: input.sql.canonical_text_output,
      snapshotId: input.sql.snapshot_id,
    }),
  createAbortError: () => new Error("AbortError"),
}));
vi.mock("src/lib/tauri/operationBus", () => ({
  operationBus: {
    subscribe: m.subscribe,
    ensureInit: async () => {},
    invalidate: vi.fn(),
  },
}));
vi.mock("src/lib/tauri/operation", () => ({ operationCancel: m.cancel }));
// The backup file session: its one write is reported as writeFile(path).
vi.mock("src/lib/tauri/backupFile", () => {
  const paths = new Map<string, string>();
  return {
    BACKUP_FILE_ALREADY_PUBLISHED: "BACKUP_FILE_ALREADY_PUBLISHED",
    BACKUP_FILE_TEMP_NOT_REMOVED: "BACKUP_FILE_TEMP_NOT_REMOVED",
    backupFileBegin: async (path: string) => {
      paths.set("f1", path);
      return "f1";
    },
    backupFileWrite: async (id: string, bytes: Uint8Array) =>
      m.writeFile(paths.get(id), bytes),
    backupFilePublish: async () => {},
    backupFileAbort: async () => {},
    backupFileForget: async () => {},
  };
});
vi.mock("src/lib/tauri/sqlSession", () => ({
  sqlSessionBegin: m.sessionBegin,
  sqlSessionEnd: m.sessionEnd,
  sqlSessionExecute: vi.fn(),
}));
vi.mock("../workspace/ConnectionRuntimeContext", () => ({
  useConnectionRuntimeCtx: () => ({
    profileId: "t1",
    runtimeConnectionId: "conn_1",
    engine: "postgres",
    metaKey: "meta",
    metadata: {
      load: async () => ({
        tables: [{ schema: "public", name: "t", kind: "table" }],
        columnsByTable: { "public.t": ["id", "note"] },
      }),
    },
    refreshSchemaAndTables: vi.fn(),
  }),
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { useDatabaseBackup } from "./useDatabaseBackup";

const S = (v: string) => ({ t: "Str", v });

type Handlers = { onChunk: (c: unknown) => void; onDone: () => void };

function streamDelivers(drive: (h: Handlers) => void) {
  m.subscribe.mockImplementation(async (_op: string, h: Handlers) => {
    queueMicrotask(() => drive(h));
    return () => {};
  });
}

/**
 * Stands in for the progress modal: a retained result (D15) is "shown"
 * through the showMessage mock with the text the modal shows, then closed.
 */
let unsubscribeModal = () => {};
beforeEach(async () => {
  const { describeDumpOutcome } = await import("../lib/dump/dumpOutcomeText");
  unsubscribeModal();
  unsubscribeModal = useDumpJobStore.subscribe((state) => {
    const summary = state.summary;
    if (!summary) return;
    const text = describeDumpOutcome(summary.outcome);
    m.showMessage(text?.message ?? "", { title: "result", kind: text?.tone });
    dismissDumpJobSummary(summary.jobId);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  useDumpJobStore.setState({ active: null, summary: null, closing: [] });
  m.saveDialog.mockResolvedValue("/tmp/out.dumb");
  m.pack.mockImplementation(async ({ sql }: { sql: string }) =>
    new TextEncoder().encode(sql)
  );
  // The snapshot holds public.t (id, note); other catalog queries find
  // nothing more.
  m.runSqlQuery.mockImplementation(async (_c: string, sql = "") => {
    if (sql.includes("SELECT n.nspname, c.relname"))
      return { rows: [[S("public"), S("t")]] };
    if (sql.includes("SELECT a.attname") && !sql.includes("walk"))
      return { rows: [[S("id")], [S("note")]] };
    return { rows: [] };
  });
  m.startSqlQueryStream.mockResolvedValue("op1");
  m.cancel.mockResolvedValue(undefined);
  m.sessionBegin.mockResolvedValue({
    sessionId: "s1",
    snapshotId: "00000003-1",
  });
  m.sessionEnd.mockResolvedValue(undefined);
  useScreenStore.setState({
    profileTabs: [
      {
        id: "t1",
        profileId: "p1",
        label: "db",
        runtimeConnectionId: "conn_1",
      } as never,
    ],
  });
});

describe("database backup file", () => {
  it("is written with every row", async () => {
    streamDelivers((h) => {
      h.onChunk({
        rows: [
          [
            { t: "Str", v: "1" },
            { t: "Str", v: "a'b" },
          ],
        ],
        columns: [
          { name: "id", db_type: "text" },
          { name: "note", db_type: "text" },
        ],
      });
      h.onDone();
    });
    const { result } = renderHook(() => useDatabaseBackup());
    await act(() => result.current.onBackupDatabase("db"));
    expect(m.writeFile).toHaveBeenCalledTimes(1);
    // Every query of the backup reads the session's snapshot.
    expect(m.sessionBegin).toHaveBeenCalledWith("conn_1", "snapshot");
    expect(m.startSqlQueryStream.mock.calls[0]![2]).toMatchObject({
      snapshotId: "00000003-1",
    });
    for (const call of m.runSqlQuery.mock.calls) {
      expect(call[2]).toMatchObject({ snapshotId: "00000003-1" });
    }
    expect(m.sessionEnd).toHaveBeenCalledWith("s1", false);
    const sql = m.pack.mock.calls[0]![0].sql as string;
    expect(sql).toContain(
      `INSERT INTO "public"."t" ("id", "note") VALUES\n  ('1', 'a''b');`
    );
  });

  it("is not written when a chunk of rows cannot be", async () => {
    streamDelivers((h) => {
      h.onChunk({ rows: "not rows", columns: [] });
      h.onDone();
    });
    const { result } = renderHook(() => useDatabaseBackup());
    await act(() => result.current.onBackupDatabase("db"));
    expect(m.writeFile).not.toHaveBeenCalled();
    expect(m.pack).not.toHaveBeenCalled();
    expect(m.cancel).toHaveBeenCalledWith("op1");
    expect(m.showMessage).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ kind: "error" })
    );
  });

  it("is not written when a sequence cannot be read", async () => {
    m.runSqlQuery.mockImplementation(async (_c: string, sql = "") => {
      if (sql.includes("SELECT n.nspname, c.relname"))
        return { rows: [[S("public"), S("t")]] };
      if (sql.includes("SELECT a.attname") && !sql.includes("walk"))
        return { rows: [[S("id")]] };
      if (sql.includes("SELECT c.oid")) return { rows: [[S("42")]] };
      if (sql.includes("format_type(a.atttypid"))
        return {
          rows: [[S("id"), S("integer"), S("t"), S(""), S("a"), S("")]],
        };
      if (sql.includes("FROM pg_sequence s"))
        throw new Error("permission denied");
      return { rows: [] };
    });
    streamDelivers((h) => h.onDone());
    const { result } = renderHook(() => useDatabaseBackup());
    await act(() => result.current.onBackupDatabase("db"));
    expect(m.writeFile).not.toHaveBeenCalled();
    expect(m.showMessage.mock.calls[0]![0]).toMatch(/could not be read/);
  });

  it("runs one backup or restore at a time", async () => {
    let finish: () => void = () => {};
    m.subscribe.mockImplementation(async (_op: string, h: Handlers) => {
      finish = () => h.onDone();
      return () => {};
    });
    const { result } = renderHook(() => useDatabaseBackup());
    let first: Promise<void> = Promise.resolve();
    await act(async () => {
      first = result.current.onBackupDatabase("db");
      // Let the first reach its stream.
      await vi.waitFor(() => expect(m.subscribe).toHaveBeenCalled());
    });
    await act(() => result.current.onBackupDatabase("db"));
    expect(m.showMessage).toHaveBeenCalledWith(
      DUMP_JOB_RUNNING_MESSAGE,
      expect.anything()
    );
    expect(m.sessionBegin).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
      await first;
    });
    expect(m.writeFile).toHaveBeenCalledTimes(1);
  });

  it("registers the job before anything is awaited", async () => {
    streamDelivers((h) => h.onDone());
    const { result } = renderHook(() => useDatabaseBackup());
    await act(async () => {
      // Started together: the second finds the first's reservation.
      await Promise.all([
        result.current.onBackupDatabase("db"),
        result.current.onBackupDatabase("db"),
      ]);
    });
    expect(m.sessionBegin).toHaveBeenCalledTimes(1);
    expect(m.showMessage).toHaveBeenCalledWith(
      DUMP_JOB_RUNNING_MESSAGE,
      expect.anything()
    );
    // Released afterwards: another backup can run.
    await act(() => result.current.onBackupDatabase("db"));
    expect(m.sessionBegin).toHaveBeenCalledTimes(2);
  });

  it("lists tables with the workspace's schema rule", async () => {
    streamDelivers((h) => h.onDone());
    const { result } = renderHook(() => useDatabaseBackup());
    await act(() => result.current.onBackupDatabase("db"));
    const list = m.runSqlQuery.mock.calls
      .map((call) => call[1] as string)
      .find((sql) => sql.includes("SELECT n.nspname, c.relname"))!;
    // "pg_" is literal: a schema named pgapp is listed.
    expect(list).toContain("n.nspname !~ '^pg_'");
    expect(list).not.toContain("LIKE");
  });
});
