import { beforeEach, describe, expect, it } from "vitest";
import { makeRowsState } from "./rowCache";
import { useConnectionStore } from "./store";
import type { TableDataState } from "./types";
import type { TableWindow } from "src/types";

const tabId = "profile-1";
const windowId = "window-1";
const key = `${tabId}.public.items`;
const tableWindow = {
  id: windowId,
  type: "table",
  table: { schema: "public", name: "items" },
} as TableWindow;
const tableData = {
  columns: [{ name: "name", db_type: "text" }],
  structure: null,
  constraints: null,
  foreignKeys: null,
  sizeInfo: null,
  rowCount: 1,
  connectionId: "connection-1",
  busy: false,
  error: null,
} satisfies TableDataState;

function seedOriginalRow(value: unknown) {
  const rowState = makeRowsState(200);
  rowState.rows[0] = [value];
  useConnectionStore.setState({
    dataPatchMap: {},
    tableDataMap: { [key]: tableData },
    tableRowsByKey: { [key]: rowState },
    tableRowCacheByKey: {},
  });
}

beforeEach(() => seedOriginalRow(""));

describe("connection edit patches", () => {
  it.each([
    ["empty string to NULL", "", null],
    ["NULL to empty string", { t: "Null" }, ""],
    ["whitespace to trimmed text", " value ", "value"],
  ])("keeps %s as a real update", (_label, original, next) => {
    seedOriginalRow(original);

    useConnectionStore.getState().setDataPatchMap(tabId, {
      dataKey: "data",
      action: "update",
      tableData,
      tableWindow,
      rowKey: "0",
      data: { name: next },
    });

    expect(
      useConnectionStore.getState().dataPatchMap[tabId]?.[windowId]?.patches
        ?.update?.data?.["0"]
    ).toEqual({ name: next });
  });

  it("prunes an update when wrapped and edited values are equal", () => {
    seedOriginalRow({ t: "Str", v: "value" });

    useConnectionStore.getState().setDataPatchMap(tabId, {
      dataKey: "data",
      action: "update",
      tableData,
      tableWindow,
      rowKey: "0",
      data: { name: "value" },
    });

    expect(
      useConnectionStore.getState().dataPatchMap[tabId]?.[windowId]?.patches
        ?.update?.data?.["0"]
    ).toBeUndefined();
  });
});

describe("row cache reset", () => {
  it("hydrates a cap-sized row buffer at the current base", () => {
    const rowState = makeRowsState(200);
    rowState.base = 10;
    rowState.rows[0] = ["stale"];
    useConnectionStore.setState({
      tableRowsByKey: { [key]: rowState },
      tableRowCacheByKey: {
        [key]: {
          map: new Map([
            [9, ["before"]],
            [10, ["first"]],
            [12, ["third"]],
            [210, ["after"]],
          ]),
          order: [9, 10, 12, 210],
          orderHead: 0,
        },
      },
    });

    useConnectionStore.getState().resetRows(key);

    const reset = useConnectionStore.getState().tableRowsByKey[key]!;
    expect(reset.rows).toHaveLength(200);
    expect(reset.rows[0]).toEqual(["first"]);
    expect(reset.rows[1]).toBeUndefined();
    expect(reset.rows[2]).toEqual(["third"]);
    expect(reset.rows).not.toContainEqual([10, ["first"]]);
    expect(reset.version).toBe(rowState.version + 1);
  });
});
