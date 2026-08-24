import { act, render } from "@testing-library/preact";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DATA_ACTIONS, DATA_KEYS } from "../../../constant";
import { useConnectionStore } from "../../../stores/connection";
import {
  buildNewRowPatch,
  useTableDataOperations,
  type UseTableDataOperationsProps,
} from "./useTableDataOperations";

type Operations = ReturnType<typeof useTableDataOperations>;

let operations: Operations | null = null;

function Harness(props: UseTableDataOperationsProps) {
  operations = useTableDataOperations(props);
  return null;
}

afterEach(() => {
  operations = null;
  vi.restoreAllMocks();
});

describe("buildNewRowPatch", () => {
  it("creates null values and a unique stable row key", () => {
    expect(
      buildNewRowPatch(
        [{ name: "id" }, { name: "name" }],
        ["new:0", "new:1", "legacy-key"]
      )
    ).toEqual({
      rowKey: "new:3",
      data: { id: null, name: null },
    });
  });

  it("uses DEFAULT for database defaults and generated columns", () => {
    expect(
      buildNewRowPatch(
        [
          { name: "id", auto_generated: true },
          { name: "created_at", column_default: "CURRENT_TIMESTAMP" },
          { name: "title" },
        ],
        []
      )
    ).toEqual({
      rowKey: "new:0",
      data: {
        id: { __politedbCellEdit: "default" },
        created_at: { __politedbCellEdit: "default" },
        title: null,
      },
    });
  });
});

describe("useTableDataOperations", () => {
  it("represents a new row only as a create patch", () => {
    const addRow = vi.fn();
    const onDataChange = vi.fn();
    const state = useConnectionStore.getState();

    vi.spyOn(useConnectionStore, "getState").mockReturnValue({
      ...state,
      addRow,
      dataPatchMap: {},
    });

    render(
      <Harness
        profileId="profile-1"
        activeTableWindowId="window-1"
        onDataChange={onDataChange}
      />
    );

    expect(operations).not.toBeNull();
    act(() => {
      operations!.handleAddRow([{ name: "id" }, { name: "name" }]);
    });

    expect(addRow).not.toHaveBeenCalled();
    expect(onDataChange).toHaveBeenCalledOnce();
    expect(onDataChange).toHaveBeenCalledWith(
      DATA_ACTIONS.create,
      DATA_KEYS.data,
      -1,
      { id: null, name: null, __rowKey: "new:0" }
    );
  });

  it("deletes an unsaved row by removing only its create patch", () => {
    const removeDataPatch = vi.fn();
    const removeRow = vi.fn();
    const onDataChange = vi.fn();
    const state = useConnectionStore.getState();

    vi.spyOn(useConnectionStore, "getState").mockReturnValue({
      ...state,
      removeDataPatch,
      removeRow,
      dataPatchMap: {
        "profile-1": {
          "window-1": {
            patches: {
              create: { data: { "new:0": { id: null } } },
            },
          },
        },
      },
    } as unknown as ReturnType<typeof useConnectionStore.getState>);

    render(
      <Harness
        profileId="profile-1"
        activeTableWindowId="window-1"
        onDataChange={onDataChange}
      />
    );

    expect(operations).not.toBeNull();
    act(() => {
      operations!.handleDeleteRow(10, "new:0");
    });

    expect(removeDataPatch).toHaveBeenCalledWith(
      "profile-1",
      "window-1",
      DATA_ACTIONS.create,
      DATA_KEYS.data,
      "new:0"
    );
    expect(removeRow).not.toHaveBeenCalled();
    expect(onDataChange).not.toHaveBeenCalled();
  });

  it("preserves the existing delete flow for loaded rows", () => {
    const onDataChange = vi.fn();
    const state = useConnectionStore.getState();

    vi.spyOn(useConnectionStore, "getState").mockReturnValue({
      ...state,
      dataPatchMap: {},
    });

    render(
      <Harness
        profileId="profile-1"
        activeTableWindowId="window-1"
        onDataChange={onDataChange}
      />
    );

    expect(operations).not.toBeNull();
    act(() => {
      operations!.handleDeleteRow(4, "4");
    });

    expect(onDataChange).toHaveBeenCalledWith(
      DATA_ACTIONS.delete,
      DATA_KEYS.data,
      4,
      {}
    );
  });
});
