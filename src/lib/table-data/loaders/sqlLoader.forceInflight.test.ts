import { afterEach, describe, expect, it, vi } from "vitest";
import { inflightRowCountByKey } from "../inflight";

const runSqlQuery = vi.fn();

vi.mock("src/lib/tauri/query", () => ({
  runSqlQuery: (...args: unknown[]) => runSqlQuery(...args),
  startSqlQueryStream: vi.fn(),
}));

describe("loadRowCount force inflight bypass", () => {
  afterEach(() => {
    inflightRowCountByKey.clear();
    runSqlQuery.mockReset();
  });

  it("does not await a hung sibling count when force is set (MenuBar refresh)", async () => {
    const { loadRowCount } = await import("./sqlLoader");

    let resolveHung!: (v: { value: number; estimated: boolean }) => void;
    const hung = new Promise<{ value: number; estimated: boolean }>((r) => {
      resolveHung = r;
    });

    // Seed a never-settling inflight entry like a cancelled pane load.
    const seedKey = JSON.stringify({
      schema: "public",
      table: "software_titles",
      engine: "mysql",
      exact: false,
      combine: "AND",
      filters: [],
    });
    inflightRowCountByKey.set(seedKey, hung);

    runSqlQuery.mockResolvedValue({ rows: [[42]] });

    const forced = loadRowCount({
      connId: "c1",
      schema: "public",
      tableName: "software_titles",
      engine: "mysql",
      addLogQuery: () => {},
      force: true,
    });

    await expect(forced).resolves.toEqual({ value: 42, estimated: false });
    expect(runSqlQuery).toHaveBeenCalled();

    // Hung sibling can still be released without blocking refresh.
    resolveHung({ value: 0, estimated: true });
    await hung;
  });

  it("coalesces into inflight when force is not set", async () => {
    const { loadRowCount } = await import("./sqlLoader");

    let resolveHung!: (v: { value: number; estimated: boolean }) => void;
    const hung = new Promise<{ value: number; estimated: boolean }>((r) => {
      resolveHung = r;
    });

    const seedKey = JSON.stringify({
      schema: "public",
      table: "software_titles",
      engine: "mysql",
      exact: false,
      combine: "AND",
      filters: [],
    });
    inflightRowCountByKey.set(seedKey, hung);

    const coalesced = loadRowCount({
      connId: "c1",
      schema: "public",
      tableName: "software_titles",
      engine: "mysql",
      addLogQuery: () => {},
    });

    resolveHung({ value: 7, estimated: true });
    await expect(coalesced).resolves.toEqual({ value: 7, estimated: true });
    expect(runSqlQuery).not.toHaveBeenCalled();
  });
});
