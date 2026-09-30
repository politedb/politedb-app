import { beforeEach, describe, expect, it, vi } from "vitest";

const loadColumns = vi.fn();
const setColumnsCache = vi.fn();

vi.mock("src/lib/table-data/loaders/sqlLoader", () => ({
  loadColumns: (...args: unknown[]) => loadColumns(...args),
}));

const mockState = {
  tableDataMap: {} as Record<string, any>,
  columnsCache: {} as Record<string, any>,
};

vi.mock("src/stores/connection", () => ({
  useConnectionStore: {
    getState: () => ({
      tableDataMap: mockState.tableDataMap,
      columnsCache: mockState.columnsCache,
      setColumnsCache,
    }),
  },
}));

import { loadStandaloneExportMetadata } from "./loadStandaloneExportMetadata";

describe("loadStandaloneExportMetadata", () => {
  beforeEach(() => {
    mockState.tableDataMap = {};
    mockState.columnsCache = {};
    loadColumns.mockReset();
    setColumnsCache.mockReset();
  });

  it("reuses tableDataMap columns without querying", async () => {
    mockState.tableDataMap["tab.public.users"] = {
      columns: [
        { name: "id", db_type: "int", is_primary: true },
        { name: "email", db_type: "text" },
      ],
      constraints: [
        { index_name: "users_pkey", is_primary: true, column_name: "id" },
      ],
    };

    const result = await loadStandaloneExportMetadata({
      profileScreenId: "tab",
      connectionId: "c1",
      engine: "postgres",
      schema: "public",
      tableName: "users",
    });

    expect(loadColumns).not.toHaveBeenCalled();
    expect(result.columns.map((c) => c.name)).toEqual(["id", "email"]);
    expect(result.constraints?.[0]?.column_name).toBe("id");
  });

  it("reuses columnsCache when tableDataMap is empty", async () => {
    mockState.columnsCache["tab.public.users"] = [
      { name: "id", db_type: "int" },
    ];

    const result = await loadStandaloneExportMetadata({
      profileScreenId: "tab",
      connectionId: "c1",
      engine: "postgres",
      schema: "public",
      tableName: "users",
    });

    expect(loadColumns).not.toHaveBeenCalled();
    expect(result.columns.map((c) => c.name)).toEqual(["id"]);
  });

  it("loads columns silently and caches them", async () => {
    loadColumns.mockResolvedValue([
      { name: "id", db_type: "int", is_primary: true },
      { name: "name", db_type: "text" },
    ]);

    const result = await loadStandaloneExportMetadata({
      profileScreenId: "tab",
      connectionId: "c1",
      engine: "postgres",
      schema: "public",
      tableName: "users",
    });

    expect(loadColumns).toHaveBeenCalledWith(
      expect.objectContaining({
        connId: "c1",
        schema: "public",
        tableName: "users",
        engine: "postgres",
      })
    );
    const addLog = loadColumns.mock.calls[0][0].addLogQuery as (
      sql: string
    ) => void;
    addLog("SELECT 1");
    expect(result.columns.map((c) => c.name)).toEqual(["id", "name"]);
    expect(setColumnsCache).toHaveBeenCalled();
  });

  it("throws on empty columns and respects cancel", async () => {
    loadColumns.mockResolvedValue([]);
    await expect(
      loadStandaloneExportMetadata({
        profileScreenId: "tab",
        connectionId: "c1",
        engine: "postgres",
        schema: "public",
        tableName: "empty",
      })
    ).rejects.toThrow(/No columns/);

    loadColumns.mockResolvedValue([{ name: "id", db_type: "int" }]);
    await expect(
      loadStandaloneExportMetadata({
        profileScreenId: "tab",
        connectionId: "c1",
        engine: "postgres",
        schema: "public",
        tableName: "users",
        isCancelled: () => true,
      })
    ).rejects.toThrow(/cancelled/i);
  });

  it("preserves exact column identifiers from cache (leading/trailing spaces)", async () => {
    mockState.columnsCache["tab.public.weird"] = [
      { name: " email ", db_type: "text" },
      { name: "email", db_type: "text" },
      { name: "  ", db_type: "text" },
      { name: "", db_type: "text" },
    ];

    const result = await loadStandaloneExportMetadata({
      profileScreenId: "tab",
      connectionId: "c1",
      engine: "postgres",
      schema: "public",
      tableName: "weird",
    });

    expect(loadColumns).not.toHaveBeenCalled();
    expect(result.columns.map((c) => c.name)).toEqual([" email ", "email"]);
  });

  it("preserves exact column identifiers from loader and writes them to cache", async () => {
    loadColumns.mockResolvedValue([
      { name: " id ", db_type: "int", is_primary: true },
      { name: "id", db_type: "int" },
      { name: "\tname", db_type: "text" },
      { name: "   ", db_type: "text" },
    ]);

    const result = await loadStandaloneExportMetadata({
      profileScreenId: "tab",
      connectionId: "c1",
      engine: "postgres",
      schema: "public",
      tableName: "weird",
    });

    expect(result.columns.map((c) => c.name)).toEqual([" id ", "id", "\tname"]);
    expect(setColumnsCache).toHaveBeenCalledWith(
      "tab.public.weird",
      expect.arrayContaining([
        expect.objectContaining({ name: " id " }),
        expect.objectContaining({ name: "id" }),
        expect.objectContaining({ name: "\tname" }),
      ])
    );
    const cached = setColumnsCache.mock.calls[0][1] as Array<{ name: string }>;
    expect(cached.map((c) => c.name)).toEqual([" id ", "id", "\tname"]);
  });

  it("preserves exact identifiers from tableDataMap cache", async () => {
    mockState.tableDataMap["tab.public.weird"] = {
      columns: [
        { name: " email ", db_type: "text" },
        { name: "email", db_type: "text" },
      ],
      constraints: null,
    };

    const result = await loadStandaloneExportMetadata({
      profileScreenId: "tab",
      connectionId: "c1",
      engine: "postgres",
      schema: "public",
      tableName: "weird",
    });

    expect(loadColumns).not.toHaveBeenCalled();
    expect(result.columns.map((c) => c.name)).toEqual([" email ", "email"]);
  });
});
