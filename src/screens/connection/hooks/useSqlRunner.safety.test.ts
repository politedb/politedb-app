import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ validate: vi.fn(), touchId: vi.fn() }));
vi.mock("src/lib/tauri/operation", () => ({
  operationCancel: vi.fn(),
  operationExecute: vi.fn(),
}));
vi.mock("src/lib/tauri/operationBus", () => ({
  operationBus: {
    ensureInit: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(async () => () => {}),
  },
}));
vi.mock("src/lib/tauri/queryValidate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri/queryValidate")>()),
  validateSqlQueryBE: mocks.validate,
}));
vi.mock("src/lib/tauri/security", () => ({
  securityTouchIdAuthenticate: mocks.touchId,
}));

import { useSqlRunner } from "./useSqlRunner";
import type { DatabaseEngine } from "src/types";

let seq = 0;

async function run(sql: string, engine: DatabaseEngine, locked: boolean) {
  const windowId = `scope:safety-${++seq}`;
  const onRunSql = vi.fn(async () => ({
    mode: "stream" as const,
    opId: `op-${seq}`,
  }));
  const hook = renderHook(() =>
    useSqlRunner({
      activeSqlWindowId: windowId,
      runtimeConnectionId: "conn-1",
      engine,
      sqlSafetyMode: locked ? "lock" : "default",
      isProfileLocked: locked,
      onRunSql,
    })
  );
  await act(async () => {
    await hook.result.current.startRun({ windowId, sql });
  });
  const runs = JSON.stringify(hook.result.current.sqlRuns);
  return { onRunSql, runs };
}

beforeEach(() => {
  mocks.validate.mockReset().mockResolvedValue(undefined);
  mocks.touchId.mockReset().mockResolvedValue(true);
});

describe("the SQL editor in Lock mode", () => {
  it.each<[string, DatabaseEngine]>([
    ["SELECT 1 # 2 INTO backup_x", "postgres"],
    ["SELECT 1--1 INTO OUTFILE '/tmp/x'", "mysql"],
    ["EXPLAIN ANALYZE DELETE FROM a", "postgres"],
    ["SELECT 'a\\' INTO OUTFILE '/tmp/x'", "mariadb"],
    ["SELECT 'a\\'b' INTO backup_x", "postgres"],
    ["--x\n/* /* */ DELETE FROM t", "sqlite"],
  ])("blocks the hidden write %s on %s", async (sql, engine) => {
    const { onRunSql, runs } = await run(sql, engine, true);
    expect(onRunSql).not.toHaveBeenCalled();
    // Blocked by Lock, not by some other early exit.
    expect(runs).toContain("This profile tab is locked");
  });

  it.each<[string, DatabaseEngine]>([
    ["SELECT $$ put into box $$", "postgres"],
    ["SELECT 1 --note INTO backup\n", "postgres"],
    ["SELECT 1 # note INTO backup\n", "mysql"],
  ])("runs the read %s on %s", async (sql, engine) => {
    const { onRunSql } = await run(sql, engine, true);
    expect(onRunSql).toHaveBeenCalledTimes(1);
  });
});

describe("the SQL editor splitting PostgreSQL text", () => {
  it("never runs the text of a continued E-string as a statement", async () => {
    const { onRunSql } = await run(
      "SELECT E'a'\n'\\'; DELETE FROM victim; --';",
      "postgres",
      false
    );
    expect(onRunSql).toHaveBeenCalledTimes(1);
    const sql = (onRunSql.mock.calls[0] as unknown as [{ sql: string }])[0].sql;
    expect(sql.startsWith("SELECT E'a'")).toBe(true);
    expect(sql).toContain("DELETE FROM victim");
  });
});
