import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useScreenStore } from "src/stores/screen";

const m = vi.hoisted(() => ({
  saveDialog: vi.fn(),
  showMessage: vi.fn(),
  writeFile: vi.fn(),
  pack: vi.fn(),
  runSqlQuery: vi.fn(),
  startSqlQueryStream: vi.fn(),
  subscribe: vi.fn(),
  cancel: vi.fn(),
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
vi.mock("src/lib/tauri/query", () => ({
  startSqlQueryStream: m.startSqlQueryStream,
  runSqlQuery: m.runSqlQuery,
}));
vi.mock("src/lib/tauri/operationBus", () => ({
  operationBus: { subscribe: m.subscribe },
}));
vi.mock("src/lib/tauri/operation", () => ({ operationCancel: m.cancel }));
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

type Handlers = { onChunk: (c: unknown) => void; onDone: () => void };

function streamDelivers(drive: (h: Handlers) => void) {
  m.subscribe.mockImplementation(async (_op: string, h: Handlers) => {
    queueMicrotask(() => drive(h));
    return () => {};
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  m.saveDialog.mockResolvedValue("/tmp/out.dumb");
  m.pack.mockImplementation(async ({ sql }: { sql: string }) =>
    new TextEncoder().encode(sql)
  );
  // Catalog queries find nothing beyond the table itself.
  m.runSqlQuery.mockResolvedValue({ rows: [] });
  m.startSqlQueryStream.mockResolvedValue("op1");
  m.cancel.mockResolvedValue(undefined);
  useScreenStore.setState({
    profileTabs: [{ id: "t1", profileId: "p1", label: "db" } as never],
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
});
