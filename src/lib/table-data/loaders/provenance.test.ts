import { afterEach, describe, expect, it, vi } from "vitest";
import { inflightRowCountByKey } from "../inflight";
import { STALE_LOAD } from "../helpers";

const m = vi.hoisted(() => ({
  runSqlQuery: vi.fn(),
  find: vi.fn(),
}));

vi.mock("src/lib/tauri/query", () => ({
  runSqlQuery: (...args: unknown[]) => m.runSqlQuery(...args),
  startSqlQueryStream: vi.fn(),
}));
vi.mock("src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri")>()),
  mongoFindDocuments: m.find,
}));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { loadRowCount } from "./sqlLoader";
import { loadMongoRows } from "./mongoLoader";
import { useConnectionStore } from "src/stores/connection";

afterEach(() => {
  inflightRowCountByKey.clear();
  vi.clearAllMocks();
});

describe("work per runtime connection (R3/R5)", () => {
  it("never shares a row count between tabs on different databases", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    m.runSqlQuery.mockImplementation(async (connId: string) => {
      if (connId === "rt-a") {
        await gateA;
        return { rows: [[1]] };
      }
      return { rows: [[2]] };
    });
    const args = {
      schema: "public",
      tableName: "t",
      engine: "mysql" as const,
      addLogQuery: () => {},
    };
    const a = loadRowCount({ connId: "rt-a", ...args });
    const b = loadRowCount({ connId: "rt-b", ...args });
    await expect(b).resolves.toMatchObject({ value: 2 });
    releaseA();
    await expect(a).resolves.toMatchObject({ value: 1 });
    // B ran its own count on its own connection.
    expect(m.runSqlQuery.mock.calls.some((c) => c[0] === "rt-b")).toBe(true);
  });
});

describe("a late answer for a tab that moved on (R5)", () => {
  it("writes no rows", async () => {
    m.find.mockResolvedValue({
      columns: [{ name: "_id", db_type: "objectId" }],
      rows: [["old"]],
      rowCount: 1,
    });
    const key = "t.db.coll";
    await expect(
      loadMongoRows({
        key,
        connId: "rt-a",
        schema: "db",
        tableName: "coll",
        limit: 10,
        offset: 0,
        isCurrent: () => false,
      } as never)
    ).rejects.toThrow(STALE_LOAD);
    expect(useConnectionStore.getState().tableRowsByKey[key]).toBeUndefined();
  });
});
