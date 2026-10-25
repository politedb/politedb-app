import { renderHook } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({ meta: {} as Record<string, unknown> }));

vi.mock("src/stores/connection", () => ({
  useConnectionStore: {
    getState: () => ({
      tableDataMap: { "tab.public.tags": store.meta },
      getRowsWindowInfo: () => null,
      initRows: () => {},
    }),
    subscribe: () => () => {},
  },
}));
vi.mock("src/lib/system-dialog", () => ({
  showMessage: vi.fn(async () => {}),
}));

import { useMainTableDataLoading } from "./useMainTableDataLoading";

type LoadMock = ReturnType<
  typeof vi.fn<
    (
      schema: string,
      table: string,
      pagination: { limit: number; offset: number },
      options: { refreshMeta?: boolean }
    ) => Promise<void>
  >
>;

function renderStructureView(loadTableData: LoadMock) {
  return renderHook(() =>
    useMainTableDataLoading({
      activeKey: "tab.public.tags",
      activeTableWindow: {
        id: "table:public.tags",
        table: { schema: "public", name: "tags" },
      },
      engine: "postgres",
      limit: 300,
      offset: 0,
      startedRef: { current: null },
      appliedFilters: [],
      appliedFilterCombine: "AND",
      filterApplySeq: 0,
      sortState: null,
      settledPagination: { limit: 300, offset: 0 },
      setSettledPagination: () => {},
      progressNow: 0,
      setProgressNow: () => {},
      viewMode: "structure",
      loadTableData,
      rerender: () => {},
    })
  );
}

const metaLoads = (loadTableData: LoadMock) =>
  loadTableData.mock.calls.filter((call) => call[3]?.refreshMeta).length;

describe("useMainTableDataLoading structure view", () => {
  it("does not reload a table whose loaded structure has no indexes", () => {
    store.meta = {
      columns: [{ name: "id", db_type: "int" }],
      structure: [{ column_name: "id" }],
      constraints: [],
      foreignKeys: [],
      busy: false,
      error: null,
    };
    const loadTableData: LoadMock = vi.fn(async () => {});
    const view = renderStructureView(loadTableData);
    view.rerender();
    view.rerender();
    expect(metaLoads(loadTableData)).toBe(0);
  });

  it("loads structure that has not loaded yet", () => {
    store.meta = {
      columns: [{ name: "id", db_type: "int" }],
      structure: null,
      constraints: null,
      foreignKeys: null,
      busy: false,
      error: null,
    };
    const loadTableData: LoadMock = vi.fn(async () => {});
    renderStructureView(loadTableData);
    expect(metaLoads(loadTableData)).toBe(1);
  });
});
