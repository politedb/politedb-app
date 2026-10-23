import { renderHook } from "@testing-library/preact";
import { describe, expect, it, vi } from "vitest";
import { makeRowsState } from "src/stores/connection/rowCache";
import { useConnectionStore } from "src/stores/connection";
import { useMainTableDataLoading } from "./useMainTableDataLoading";

vi.mock("src/lib/system-dialog", () => ({ showMessage: vi.fn() }));

const key = "tab.public.big";

/** A page whose rows were streamed in full, with the given row count. */
function seed(rowCount: number, estimated: boolean, loaded: number) {
  const rows = makeRowsState(200);
  rows.base = 1000;
  rows.streamOffset = 1000;
  rows.loadedMax = 1000 + loaded - 1;
  rows.running = false;
  useConnectionStore.setState({
    tableDataMap: {
      [key]: {
        columns: [{ name: "id", db_type: "int" }],
        structure: null,
        constraints: null,
        foreignKeys: null,
        sizeInfo: null,
        rowCount,
        rowCountIsEstimated: estimated,
        busy: false,
        error: null,
      },
    } as any,
    tableRowsByKey: { [key]: rows } as any,
  });
}

function renderLoading() {
  const limit = 100;
  const offset = 1000;
  // The rows for this query are already loaded: no new load starts.
  const startedRef = { current: `${key}:${limit}:${offset}:AND:[]:::0` };
  return renderHook(() =>
    useMainTableDataLoading({
      activeKey: key,
      activeTableWindow: { id: "w", table: { schema: "public", name: "big" } },
      engine: "postgres",
      limit,
      offset,
      startedRef,
      appliedFilters: [],
      appliedFilterCombine: "AND",
      filterApplySeq: 0,
      sortState: null,
      settledPagination: { limit, offset },
      setSettledPagination: vi.fn(),
      progressNow: 0,
      setProgressNow: vi.fn(),
      viewMode: "data",
      loadTableData: vi.fn(async () => {}),
      rerender: vi.fn(),
    })
  ).result.current;
}

describe("useMainTableDataLoading page bounds", () => {
  it("shows a full page past a low estimate", () => {
    seed(1000, true, 100);
    const state = renderLoading();
    expect(state.exactRowCount).toBeNull();
    expect(state.basePageTotal).toBe(100);
    expect(state.loadedRowCount).toBe(100);
    expect(state.rowsSettled).toBe(true);
  });

  it("settles a partial last page past an estimate", () => {
    seed(1000, true, 41);
    const state = renderLoading();
    expect(state.basePageTotal).toBe(100);
    expect(state.loadedRowCount).toBe(41);
    expect(state.rowsSettled).toBe(true);
  });

  it("still bounds pages by an exact count", () => {
    seed(1041, false, 41);
    const state = renderLoading();
    expect(state.exactRowCount).toBe(1041);
    expect(state.basePageTotal).toBe(41);
    expect(state.rowsSettled).toBe(true);
  });
});
