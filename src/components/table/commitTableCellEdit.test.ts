import { describe, expect, it, vi } from "vitest";
import { commitTableCellEdit } from "./commitTableCellEdit";

const helpers = {
  isNewRow: () => false,
  getRowKey: () => "new_1",
  getPatchedValue: (_rowIndex: number, _colName: string, fallback: unknown) =>
    fallback,
};

describe("commitTableCellEdit", () => {
  it("commits null values without converting them to text", () => {
    const onCellChange = vi.fn();

    const changed = commitTableCellEdit({
      rowIdx: 0,
      columnName: "enabled",
      newValue: null,
      columns: [{ name: "enabled", db_type: "boolean" }],
      getRowArray: () => [true],
      patchHelpers: helpers,
      newRows: [],
      dataKey: "data",
      onCellChange,
    });

    expect(changed).toBe(true);
    expect(onCellChange).toHaveBeenCalledWith("update", "data", 0, {
      enabled: null,
    });
  });

  it("commits boolean values as booleans", () => {
    const onCellChange = vi.fn();

    commitTableCellEdit({
      rowIdx: 0,
      columnName: "enabled",
      newValue: false,
      columns: [{ name: "enabled", db_type: "boolean" }],
      getRowArray: () => [true],
      patchHelpers: helpers,
      newRows: [],
      dataKey: "data",
      onCellChange,
    });

    expect(onCellChange).toHaveBeenCalledWith("update", "data", 0, {
      enabled: false,
    });
  });
});
