import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  runSqlQuery: vi.fn(),
  startSqlQueryStream: vi.fn(),
  subscribe: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("src/lib/tauri/query", () => ({
  startSqlQueryStream: m.startSqlQueryStream,
  runSqlQuery: m.runSqlQuery,
}));
vi.mock("src/lib/tauri/operationBus", () => ({
  operationBus: { subscribe: m.subscribe },
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

function exportWith(drive: (h: Handlers) => void) {
  m.subscribe.mockImplementation(async (_opId: string, h: Handlers) => {
    queueMicrotask(() => drive(h));
  });
  const parts: string[] = [];
  const done = exportTableToSqlParts({
    append: (content) => parts.push(content),
    connectionId: "c1",
    engine: "postgres",
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
  });

  it("fails, and stops the stream, when a chunk cannot be written", async () => {
    const { done, parts } = exportWith((h) => {
      // Rows that do not match their column list cannot be written.
      h.onChunk({ rows: "not rows" as never, columns: [] });
      h.onDone();
    });
    await expect(done).rejects.toBeTruthy();
    expect(m.cancel).toHaveBeenCalledWith("op1");
    expect(parts.join("")).not.toContain("INSERT");
  });
});
