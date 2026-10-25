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
  it("removes multiple draft columns without restoring stale rows or misaligning patches", () => {
    const store = useConnectionStore.getState();
    const rows = ["original", "draft_a", "draft_b", "draft_c"].map(
      (column_name) => ({
        column_name,
        data_type: "text",
        is_nullable: "true",
        check: "",
        column_default: "",
        foreign_key: "",
        comment: "",
      })
    );
    store.setTableStructure(tabId, windowId, rows);
    for (let index = 1; index < rows.length; index++) {
      store.setDataPatchMap(tabId, {
        dataKey: "structure",
        action: "create",
        tableData,
        tableWindow,
        rowKey: String(index),
        data: rows[index],
      });
    }
    store.setDataPatchMap(tabId, {
      dataKey: "constraints",
      action: "create",
      tableData,
      tableWindow,
      rowKey: "0",
      data: { index_name: "keep_index" },
    });
    store.removeNewStructureRow(tabId, windowId, 2);
    store.removeNewStructureRow(tabId, windowId, 1);
    const state = useConnectionStore.getState();
    expect(
      state.tableStructure[tabId][windowId].map((row) => row.column_name)
    ).toEqual(["original", "draft_c"]);
    expect(
      state.dataPatchMap[tabId][windowId].patches.create?.structure
    ).toEqual({ "1": rows[3] });
    expect(
      state.dataPatchMap[tabId][windowId].patches.create?.constraints
    ).toEqual({ "0": { index_name: "keep_index" } });
    store.removeNewStructureRow(tabId, windowId, 1);
    expect(
      useConnectionStore.getState().dataPatchMap[tabId][windowId].patches.create
        ?.structure
    ).toBeUndefined();
  });
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
    expect(
      useConnectionStore.getState().dataPatchMap[tabId]?.[windowId]
        ?.originalRows?.["0"]
    ).toEqual([original]);
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

  const edit = (action: "update" | "delete", data: Record<string, unknown>) =>
    useConnectionStore.getState().setDataPatchMap(tabId, {
      dataKey: "data",
      action,
      tableData,
      tableWindow,
      rowKey: "0",
      data,
    });
  const windowEntry = () =>
    useConnectionStore.getState().dataPatchMap[tabId]?.[windowId];
  /** Loads `row` at position 0 in the original-row cache, as a stream does. */
  const loadCached = (row: unknown[]) =>
    useConnectionStore.setState({
      tableRowCacheByKey: {
        [key]: { map: new Map([[0, row]]), order: [0], orderHead: 0 },
      } as any,
    });

  it("records the edited row outside the patch and keeps it for later actions", () => {
    loadCached(["Ada"]);
    expect(edit("update", { name: "Grace" })).toBe(true);
    expect(windowEntry()?.patches.update?.data?.["0"]).toEqual({
      name: "Grace",
    });
    expect(windowEntry()?.originalRows).toEqual({ "0": ["Ada"] });

    edit("update", { name: "Hopper" });
    edit("delete", {});
    expect(windowEntry()?.patches.delete?.data?.["0"]).toEqual({});
    expect(windowEntry()?.originalRows).toEqual({ "0": ["Ada"] });

    // Reverting the edit keeps the record while the delete remains.
    edit("update", { name: "Ada" });
    expect(windowEntry()?.patches.update?.data?.["0"]).toBeUndefined();
    expect(windowEntry()?.originalRows).toEqual({ "0": ["Ada"] });
  });

  it("refuses an action on a position another row has taken since", () => {
    loadCached(["Ada"]);
    edit("update", { name: "Grace" });

    // A reload put another row at position 0 while the edit was pending.
    loadCached(["Linus"]);
    // Refused, and reported so the grid does not show a change never saved.
    expect(edit("delete", {})).toBe(false);
    expect(edit("update", { name: "Torvalds" })).toBe(false);

    expect(windowEntry()?.patches.delete).toBeUndefined();
    expect(windowEntry()?.patches.update?.data?.["0"]).toEqual({
      name: "Grace",
    });
    expect(windowEntry()?.originalRows).toEqual({ "0": ["Ada"] });
  });

  it("drops the record when no row change remains", () => {
    loadCached(["Ada"]);
    edit("update", { name: "Grace" });
    edit("update", { name: "Ada" });
    expect(windowEntry()?.originalRows ?? {}).toEqual({});
  });

  it("treats a column named like the internal record as an ordinary column", () => {
    loadCached(["Ada"]);
    useConnectionStore.getState().setDataPatchMap(tabId, {
      dataKey: "data",
      action: "update",
      tableData: {
        ...tableData,
        columns: [{ name: "__originalRow", db_type: "text" }],
      },
      tableWindow,
      rowKey: "0",
      data: { __originalRow: "Grace" },
    });
    expect(windowEntry()?.patches.update?.data?.["0"]).toEqual({
      __originalRow: "Grace",
    });
    expect(windowEntry()?.originalRows).toEqual({ "0": ["Ada"] });
  });
});

describe("structure nullable edits", () => {
  // The catalog loaders give booleans; the structure editor writes YES/NO.
  function seedStructure(isNullable: boolean) {
    useConnectionStore.setState({
      dataPatchMap: {},
      tableDataMap: {
        [key]: {
          ...tableData,
          structure: [
            {
              column_name: "name",
              data_type: "text",
              is_nullable: isNullable,
              check: "",
              column_default: "",
              foreign_key: "",
              comment: "",
            },
          ],
        },
      },
    });
  }
  const choose = (value: string) =>
    useConnectionStore.getState().setDataPatchMap(tabId, {
      dataKey: "structure",
      action: "update",
      tableData,
      tableWindow,
      rowKey: "0",
      data: { is_nullable: value },
    });
  const pending = () =>
    useConnectionStore.getState().dataPatchMap[tabId]?.[windowId]?.patches
      ?.update?.structure?.["0"];

  it("keeps no change when the current value is chosen", () => {
    seedStructure(true);
    choose("YES");
    expect(pending()).toBeUndefined();
  });

  it("clears the change after true -> NO -> YES", () => {
    seedStructure(true);
    choose("NO");
    expect(pending()).toEqual({ is_nullable: "NO" });
    choose("YES");
    expect(pending()).toBeUndefined();
  });

  it("clears the change after false -> YES -> NO", () => {
    seedStructure(false);
    choose("YES");
    expect(pending()).toEqual({ is_nullable: "YES" });
    choose("NO");
    expect(pending()).toBeUndefined();
  });
});

describe("structure rename edits", () => {
  const rename = (data: Record<string, unknown>) =>
    useConnectionStore.getState().setDataPatchMap(tabId, {
      dataKey: "structure",
      action: "update",
      tableData,
      tableWindow,
      rowKey: "-1",
      data,
    });
  const pending = () =>
    useConnectionStore.getState().dataPatchMap[tabId]?.[windowId]?.patches
      ?.update?.structure?.["-1"];

  beforeEach(() => {
    useConnectionStore.setState({
      dataPatchMap: {},
      tableDataMap: { [key]: { ...tableData, constraints: [] } },
    });
  });

  it("keeps no rename for the same name with spaces, or a blank one", () => {
    rename({ tableName: " items " });
    expect(pending()).toBeUndefined();
    rename({ tableName: "   " });
    expect(pending()).toBeUndefined();
  });

  it("keeps a real rename as typed and clears it on undo", () => {
    rename({ tableName: " goods " });
    expect(pending()).toEqual({ tableName: " goods " });
    rename({ tableName: "items" });
    expect(pending()).toBeUndefined();
  });

  it("keeps a primary key edit when the rename is undone", () => {
    rename({ tableName: "goods", primaryKey: ["name"] });
    rename({ tableName: "items" });
    expect(pending()).toEqual({ primaryKey: ["name"] });
  });
});

describe("renaming a table whose name has spaces", () => {
  const paddedWindow = {
    ...tableWindow,
    table: { schema: "public", name: " items " },
  } as TableWindow;
  const rename = (data: Record<string, unknown>) =>
    useConnectionStore.getState().setDataPatchMap(tabId, {
      dataKey: "structure",
      action: "update",
      tableData,
      tableWindow: paddedWindow,
      rowKey: "-1",
      data,
    });
  const pending = () =>
    useConnectionStore.getState().dataPatchMap[tabId]?.[windowId]?.patches
      ?.update?.structure?.["-1"];

  beforeEach(() => {
    useConnectionStore.setState({
      dataPatchMap: {},
      tableDataMap: {
        [`${tabId}.public. items `]: { ...tableData, constraints: [] },
      },
    });
  });

  it("keeps the rename to the trimmed name", () => {
    rename({ tableName: "items" });
    expect(pending()).toEqual({ tableName: "items" });
  });

  it("drops the rename on undo to the exact name", () => {
    rename({ tableName: "goods" });
    rename({ tableName: " items " });
    expect(pending()).toBeUndefined();
  });

  it("keeps a primary key edit when the rename is undone", () => {
    rename({ tableName: "goods", primaryKey: ["name"] });
    rename({ tableName: " items " });
    expect(pending()).toEqual({ primaryKey: ["name"] });
  });
});

describe("deleting a draft index in the editor", () => {
  it("leaves nothing that blocks saving the other changes", async () => {
    const { generateSqlFromPatches } = await import("src/lib/patches");
    const withConstraints = { ...tableData, constraints: [], structure: [] };
    useConnectionStore.setState({
      dataPatchMap: {},
      tableDataMap: { [key]: withConstraints },
    });
    const store = useConnectionStore.getState();
    store.setDataPatchMap(tabId, {
      dataKey: "constraints",
      action: "create",
      tableData: withConstraints,
      tableWindow,
      rowKey: "0",
      data: { index_name: "", column_name: "" },
    });
    store.setDataPatchMap(tabId, {
      dataKey: "constraints",
      action: "delete",
      tableData: withConstraints,
      tableWindow,
      rowKey: "0",
      data: {},
    });
    store.setDataPatchMap(tabId, {
      dataKey: "structure",
      action: "update",
      tableData: withConstraints,
      tableWindow,
      rowKey: "-1",
      data: { tableName: "goods" },
    });
    const patchMap = useConnectionStore.getState().dataPatchMap[tabId];
    expect(generateSqlFromPatches(patchMap as never, "postgres")).toEqual([
      'ALTER TABLE "public"."items" RENAME TO "goods";',
    ]);
  });
});
