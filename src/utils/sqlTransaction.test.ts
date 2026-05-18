import { describe, expect, it, vi } from "vitest";
import { runSqlTransaction, sqlTransactionControl } from "./sqlTransaction";

describe("sqlTransaction", () => {
  it("uses engine-specific transaction control statements", () => {
    expect(sqlTransactionControl("postgres")).toEqual({
      begin: "BEGIN;",
      commit: "COMMIT;",
      rollback: "ROLLBACK;",
    });
    expect(sqlTransactionControl("sqlserver")).toEqual({
      begin: "BEGIN TRANSACTION;",
      commit: "COMMIT TRANSACTION;",
      rollback: "ROLLBACK TRANSACTION;",
    });
    expect(sqlTransactionControl("oracle")).toEqual({
      begin: null,
      commit: "COMMIT;",
      rollback: "ROLLBACK;",
    });
  });

  it("commits statements in order", async () => {
    const run = vi.fn<(_: string) => Promise<void>>().mockResolvedValue();

    await runSqlTransaction({
      engine: "postgres",
      statements: ["UPDATE t SET a=1;"],
      run,
    });

    expect(run.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN;",
      "UPDATE t SET a=1;",
      "COMMIT;",
    ]);
  });

  it("delegates to backend batch execution when available", async () => {
    const run = vi.fn<(_: string) => Promise<void>>().mockResolvedValue();
    const runBatch = vi
      .fn<(_: string[]) => Promise<void>>()
      .mockResolvedValue();
    const statements = ["UPDATE t SET a=1;", "DELETE FROM t WHERE id=2;"];

    await runSqlTransaction({
      engine: "postgres",
      statements,
      run,
      runBatch,
    });

    expect(run).not.toHaveBeenCalled();
    expect(runBatch).toHaveBeenCalledWith(statements);
  });

  it("rolls back when a statement fails", async () => {
    const run = vi
      .fn<(_: string) => Promise<void>>()
      .mockImplementation(async (sql) => {
        if (sql.startsWith("UPDATE")) throw new Error("failed");
      });

    await expect(
      runSqlTransaction({
        engine: "mysql",
        statements: ["UPDATE t SET a=1;"],
        run,
      })
    ).rejects.toThrow("failed");

    expect(run.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN;",
      "UPDATE t SET a=1;",
      "ROLLBACK;",
    ]);
  });
});
