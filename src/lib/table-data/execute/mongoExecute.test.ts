import { describe, expect, it, vi, beforeEach } from "vitest";
import { executeMongoLoad } from "./mongoExecute";
import type { LoadExecutionContext } from "./types";

const loadMongoOverview = vi.fn();
const loadMongoRows = vi.fn();
const loadMongoSizeInfo = vi.fn();
const loadMongoRowCount = vi.fn();

vi.mock("../loaders/mongoLoader", () => ({
  loadMongoOverview: (...args: unknown[]) => loadMongoOverview(...args),
  loadMongoRows: (...args: unknown[]) => loadMongoRows(...args),
  loadMongoSizeInfo: (...args: unknown[]) => loadMongoSizeInfo(...args),
  loadMongoRowCount: (...args: unknown[]) => loadMongoRowCount(...args),
}));

function ctx(
  patch: Partial<LoadExecutionContext> &
    Pick<LoadExecutionContext, "plan" | "flags" | "prev">
): LoadExecutionContext {
  const setMeta = vi.fn();
  return {
    key: "p/db/users",
    loadSignature: "sig",
    schema: "tracking",
    tableName: "users",
    connId: "conn-1",
    limit: 300,
    offset: 0,
    engine: "mongo",
    profileId: "p",
    supportsMeta: false,
    columnsCache: {},
    sizeInfoCache: {},
    setMeta,
    setColumnsCache: vi.fn(),
    setSizeInfoCache: vi.fn(),
    addLogQuery: vi.fn(),
    ...patch,
  };
}

describe("executeMongoLoad", () => {
  beforeEach(() => {
    loadMongoOverview.mockReset();
    loadMongoRows.mockReset();
    loadMongoSizeInfo.mockReset();
    loadMongoRowCount.mockReset();
    loadMongoOverview.mockResolvedValue({
      columns: [{ name: "_id", db_type: "object_id" }],
      structure: [],
      constraints: [],
      rowCount: 99,
    });
    loadMongoSizeInfo.mockResolvedValue({
      totalSize: "1 KB",
      dataSize: "1 KB",
      indexSize: "0 B",
    });
    loadMongoRows.mockResolvedValue({
      columns: [{ name: "_id", db_type: "object_id" }],
      rowCount: 2,
      rowCountIsEstimated: false,
    });
  });

  it("passes filter and sort into document find", async () => {
    const filters = [
      {
        id: 1,
        column: "status",
        operator: "=",
        value: "active",
        enabled: true,
      },
    ];
    const sortBy = { colName: "createdAt", direction: "desc" as const };

    await executeMongoLoad(
      ctx({
        prev: { columns: [{ name: "_id", db_type: "object_id" }] },
        flags: {
          filters,
          filterCombine: "AND",
          sortBy,
          forceRows: true,
          refreshRowCount: true,
        },
        plan: {
          key: "p/db/users",
          prev: {},
          force: false,
          isFirstLoad: false,
          needColumns: false,
          needRows: true,
          needRowCount: true,
          needSizeInfo: false,
          needMeta: false,
          needForeignKeys: false,
          needAnyMetaWork: false,
        },
      })
    );

    expect(loadMongoOverview).not.toHaveBeenCalled();
    expect(loadMongoRows).toHaveBeenCalledWith(
      expect.objectContaining({
        filters,
        filterCombine: "AND",
        sortBy,
        exactCount: true,
      })
    );
  });

  it("keeps zero filtered matches instead of stale unfiltered count", async () => {
    loadMongoRows.mockResolvedValue({
      columns: [{ name: "_id", db_type: "object_id" }],
      rowCount: 0,
      rowCountIsEstimated: false,
    });
    const setMeta = vi.fn();

    await executeMongoLoad(
      ctx({
        setMeta,
        prev: {
          columns: [{ name: "_id", db_type: "object_id" }],
          rowCount: 99,
        },
        flags: {
          filters: [
            {
              id: 1,
              column: "name",
              operator: "=",
              value: "missing",
              enabled: true,
            },
          ],
          forceRows: true,
        },
        plan: {
          key: "p/db/users",
          prev: {},
          force: false,
          isFirstLoad: false,
          needColumns: false,
          needRows: true,
          needRowCount: true,
          needSizeInfo: false,
          needMeta: false,
          needForeignKeys: false,
          needAnyMetaWork: false,
        },
      })
    );

    const rowCountPatches = setMeta.mock.calls
      .map(([, patch]) => patch?.rowCount)
      .filter((value: unknown) => typeof value === "number");
    expect(rowCountPatches).toContain(0);
  });
});
