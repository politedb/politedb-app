import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  runSqlQuery: vi.fn(),
  startSqlQueryStream: vi.fn(),
  subscribe: vi.fn(),
  cancel: vi.fn(),
  unsubscribe: vi.fn(),
}));
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
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { exportTableToSqlParts } from "./useDatabaseBackup";
import { postgresMoneyValueSql } from "./sqlInsertLiteral";

type Handlers = {
  onChunk: (chunk: unknown) => void;
  onDone: () => void;
  onError: (err: unknown) => void;
};

beforeEach(() => {
  vi.clearAllMocks();
  m.startSqlQueryStream.mockResolvedValue("op1");
  m.cancel.mockResolvedValue(undefined);
  m.runSqlQuery
    // PostgreSQL 14+, then the money walk: "ms" is money[].
    .mockResolvedValueOnce({ rows: [[{ t: "Bool", v: true }]] })
    .mockResolvedValueOnce({
      rows: [
        [
          { t: "Str", v: "ms" },
          { t: "Str", v: "a" },
        ],
      ],
    });
});

function exportWith(
  drive: (h: Handlers) => void,
  engine: "postgres" | "mysql" = "postgres"
) {
  m.subscribe.mockImplementation(async (_opId: string, h: Handlers) => {
    queueMicrotask(() => drive(h));
    return m.unsubscribe;
  });
  const parts: string[] = [];
  const done = exportTableToSqlParts({
    append: (content) => parts.push(content),
    connectionId: "c1",
    engine,
    schema: "s",
    tableName: "t",
    columns: ["ms"],
  });
  return { done, parts };
}

const chunk = (v: string) => ({
  rows: [[{ t: "Str", v }]],
  columns: [{ name: "ms", db_type: "text" }],
});

describe("exportTableToSqlParts", () => {
  it("writes a money array of 200,000 elements", async () => {
    const big = `{${Array(200_000).fill("1.25").join(",")}}`;
    expect(postgresMoneyValueSql(big, "numeric[]")).toContain(">= 2 THEN");
    const { done, parts } = exportWith((h) => {
      h.onChunk(chunk(big));
      h.onDone();
    });
    await done;
    expect(parts.join("")).toContain("::numeric[]");
    await vi.waitFor(() => expect(m.unsubscribe).toHaveBeenCalled());
  });

  it("fails, and stops the stream, when a chunk cannot be written", async () => {
    const { done, parts } = exportWith((h) => {
      // Rows that do not match their column list cannot be written.
      h.onChunk({ rows: "not rows" as never, columns: [] });
      // Late chunks after the failure are not kept.
      h.onChunk(chunk("{1.25}"));
      h.onDone();
    });
    await expect(done).rejects.toBeTruthy();
    expect(m.cancel).toHaveBeenCalledTimes(1);
    expect(m.cancel).toHaveBeenCalledWith("op1");
    expect(parts.join("")).not.toContain("INSERT");
    await vi.waitFor(() => expect(m.unsubscribe).toHaveBeenCalled());
  });

  it("fails a MySQL backup, instead of waiting, when a chunk cannot be written", async () => {
    const { done, parts } = exportWith((h) => {
      h.onChunk({ rows: "not rows" as never, columns: [] });
      h.onDone();
    }, "mysql");
    await expect(done).rejects.toBeTruthy();
    expect(m.cancel).toHaveBeenCalledWith("op1");
    expect(parts.join("")).not.toContain("INSERT");
    // No PostgreSQL catalog queries, no snapshot, no fixed text formats.
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(m.startSqlQueryStream.mock.calls[0]![2]).toMatchObject({
      canonicalTextOutput: false,
      snapshotId: undefined,
    });
    await vi.waitFor(() => expect(m.unsubscribe).toHaveBeenCalled());
  });
});
