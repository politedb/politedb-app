import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDatabases, type DatabaseChangeCheck } from "./useDatabases";

const m = vi.hoisted(() => ({ runSqlQuery: vi.fn() }));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: m.runSqlQuery }));

let inCheckTurn = false;

beforeEach(() => {
  inCheckTurn = false;
  m.runSqlQuery.mockReset().mockImplementation(async (_id, sql: string) => {
    if (/DROP/.test(sql)) expect(inCheckTurn).toBe(true);
    return { rows: [] };
  });
});

function setup(check: DatabaseChangeCheck) {
  return renderHook(() =>
    useDatabases({
      open: false,
      engine: "postgres",
      runtimeConnectionId: "c1",
      beforeChange: () => check,
    })
  );
}

describe("useDatabases database changes", () => {
  it("sends the SQL in the same turn as the final check", async () => {
    const order: string[] = [];
    const { result } = setup({
      prepare: async () => {
        order.push("prepare");
        return null;
      },
      checkNow: () => {
        order.push("checkNow");
        inCheckTurn = true;
        queueMicrotask(() => (inCheckTurn = false));
        return null;
      },
    });
    await act(async () => {
      expect(await result.current.onDropDbByName("victim")).toBe(true);
    });
    expect(order).toEqual(["prepare", "checkNow"]);
    expect(m.runSqlQuery).toHaveBeenCalledWith(
      "c1",
      expect.stringContaining('DROP DATABASE "victim"')
    );
  });

  it.each<[string, DatabaseChangeCheck]>([
    ["prepare", { prepare: async () => "no", checkNow: () => null }],
    ["checkNow", { prepare: async () => null, checkNow: () => "no" }],
  ])("sends nothing when %s refuses", async (_, check) => {
    const { result } = setup(check);
    await act(async () => {
      expect(await result.current.onDropDbByName("victim")).toBe(false);
    });
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(result.current.error).toBe("no");
  });
});
