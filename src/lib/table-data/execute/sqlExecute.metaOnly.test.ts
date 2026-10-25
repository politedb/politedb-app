import { describe, expect, it, vi } from "vitest";

const loaders = vi.hoisted(() => ({
  loadColumns: vi.fn(),
  loadForeignKeys: vi.fn(async () => []),
  loadMeta: vi.fn(async () => ({ structure: [], constraints: [] })),
  loadRowCount: vi.fn(),
  loadSizeInfo: vi.fn(),
  startRowsStream: vi.fn(),
}));
const state = vi.hoisted(() => ({ meta: {} as Record<string, unknown> }));

vi.mock("../loaders/sqlLoader", () => loaders);
vi.mock("src/stores/connection", () => ({
  useConnectionStore: {
    getState: () => ({
      tableDataMap: { "tab.public.users": state.meta },
      getRowsWindowInfo: () => null,
    }),
  },
}));

import { executeSqlLoad } from "./sqlExecute";
import { computeLoadPlan } from "../loadPlan";
import { latestLoadSignatureByKey } from "../inflight";

describe("executeSqlLoad metaOnly", () => {
  it("loads structure without rerunning the data query or clearing its error", async () => {
    const dataError = 'column "nme" does not exist';
    state.meta = {
      columns: [{ name: "id", db_type: "int" }],
      structure: null,
      constraints: null,
      foreignKeys: null,
      sizeInfo: null,
      rowCount: null,
      busy: true,
      error: dataError,
    };
    const flags = { metaOnly: true, refreshForeignKeys: true };
    const plan = computeLoadPlan({
      key: "tab.public.users",
      prev: state.meta,
      engine: "postgres",
      flags,
      pagination: { limit: 300, offset: 0 },
    });
    latestLoadSignatureByKey.set("tab.public.users", "sig");
    const setMeta = vi.fn((_key: string, next: Record<string, unknown>) => {
      state.meta = next;
    });

    await executeSqlLoad({
      key: "tab.public.users",
      loadSignature: "sig",
      schema: "public",
      tableName: "users",
      connId: "conn-1",
      plan,
      prev: state.meta as never,
      flags,
      limit: 300,
      offset: 0,
      engine: "postgres",
      profileId: "p",
      supportsMeta: true,
      columnsCache: {},
      sizeInfoCache: {},
      setMeta,
      setColumnsCache: vi.fn(),
      setSizeInfoCache: vi.fn(),
      addLogQuery: vi.fn(),
    } as never);

    expect(loaders.startRowsStream).not.toHaveBeenCalled();
    expect(loaders.loadRowCount).not.toHaveBeenCalled();
    expect(loaders.loadColumns).not.toHaveBeenCalled();
    expect(loaders.loadMeta).toHaveBeenCalledTimes(1);
    expect(state.meta).toMatchObject({
      structure: [],
      constraints: [],
      busy: false,
      error: dataError,
    });
  });
});
