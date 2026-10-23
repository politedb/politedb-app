import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "src/stores/connection";
import {
  confirmRowsChangeIn,
  useConfirmRowsChange,
} from "./useConfirmRowsChange";

const confirmDialogMock = vi.fn();
vi.mock("src/lib/system-dialog", () => ({
  confirmDialog: (...args: unknown[]) => confirmDialogMock(...args),
}));

const tableWindow = { id: "win", table: { schema: "public", name: "t" } };

function seed(
  patches: Record<string, unknown>,
  originalRows: Record<string, unknown[]> = {}
) {
  useConnectionStore.setState({
    dataPatchMap: {
      tab: { win: { tableWindow, patches, originalRows } },
    } as any,
  });
}

const patchesOf = () =>
  (useConnectionStore.getState().dataPatchMap as any).tab.win.patches;

describe("useConfirmRowsChange", () => {
  beforeEach(() => {
    confirmDialogMock.mockReset();
    useConnectionStore.setState({ dataPatchMap: {} as any });
  });

  it("goes ahead without asking when no row is edited or deleted", async () => {
    seed({ create: { data: { new_1: { a: 1 } } } });
    const { result } = renderHook(() =>
      useConfirmRowsChange("tab", "public", "t")
    );
    let ok = false;
    await act(async () => {
      ok = await result.current();
    });
    expect(ok).toBe(true);
    expect(confirmDialogMock).not.toHaveBeenCalled();
  });

  it("keeps everything when the user cancels", async () => {
    seed({ update: { data: { "3": { a: 2 } } } });
    confirmDialogMock.mockResolvedValue(false);
    const { result } = renderHook(() =>
      useConfirmRowsChange("tab", "public", "t")
    );
    let ok = true;
    await act(async () => {
      ok = await result.current();
    });
    expect(ok).toBe(false);
    expect(confirmDialogMock.mock.calls[0][1]).toMatchObject({
      okLabel: "Discard changes",
    });
    expect(patchesOf().update.data).toEqual({ "3": { a: 2 } });
  });

  it("discards only row edits and deletions when confirmed", async () => {
    seed(
      {
        create: { data: { new_1: { a: 1 } } },
        update: {
          data: { "1": { a: 2 } },
          structure: { "0": { column_name: "b" } },
        },
        delete: { data: { "0": {} } },
      },
      { "1": [1], "0": [0] }
    );
    // The edit was also written into the loaded rows (page at offset 0), and
    // the edited row is selected.
    useConnectionStore.setState({
      selectedRowByKey: { "tab.public.t": { rowIndex: 1 } } as any,
      tableRowsByKey: {
        "tab.public.t": { base: 0, cap: 2, streamOffset: 0, rows: [[0], [2]] },
      } as any,
    });
    confirmDialogMock.mockResolvedValue(true);
    const { result } = renderHook(() =>
      useConfirmRowsChange("tab", "public", "t")
    );
    let ok = false;
    await act(async () => {
      ok = await result.current();
    });
    expect(ok).toBe(true);
    expect(patchesOf()).toEqual({
      create: { data: { new_1: { a: 1 } } },
      update: { structure: { "0": { column_name: "b" } } },
      delete: {},
    });
    // The grid shows the loaded value again, not the discarded edit.
    expect(
      (useConnectionStore.getState().tableRowsByKey as any)["tab.public.t"].rows
    ).toEqual([[0], [1]]);
    expect(
      (useConnectionStore.getState().dataPatchMap as any).tab.win.originalRows
    ).toEqual({});
    expect(useConnectionStore.getState().selectedRowByKey).toEqual({});
  });

  it("checks every window of a destination table, not only the current one", async () => {
    const parent = { id: "parent-win", table: { schema: "public", name: "b" } };
    const child = { id: "child-win", table: { schema: "public", name: "a" } };
    useConnectionStore.setState({
      dataPatchMap: {
        tab: {
          "parent-win": {
            tableWindow: parent,
            patches: { update: { data: { "0": { x: 1 } } } },
          },
          "child-win": {
            tableWindow: child,
            patches: { delete: { data: { "2": {} } } },
          },
        },
      } as any,
    });
    confirmDialogMock.mockResolvedValue(true);

    let ok = false;
    await act(async () => {
      ok = await confirmRowsChangeIn(
        "tab",
        (win) => win.table.schema === "public" && win.table.name === "b"
      );
    });
    expect(ok).toBe(true);
    const map = useConnectionStore.getState().dataPatchMap as any;
    expect(map.tab["parent-win"].patches.update).toEqual({});
    // The table the user is leaving keeps its own changes.
    expect(map.tab["child-win"].patches.delete.data).toEqual({ "2": {} });
  });
});
