import { describe, expect, it, vi } from "vitest";
import { defaultCellEditValue } from "src/lib/table-data/cellEditValue";
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

  it("distinguishes NULL from an empty string", () => {
    const onCellChange = vi.fn();

    const changed = commitTableCellEdit({
      rowIdx: 0,
      columnName: "name",
      newValue: null,
      columns: [{ name: "name", db_type: "text" }],
      getRowArray: () => [""],
      patchHelpers: helpers,
      newRows: [],
      dataKey: "data",
      onCellChange,
    });

    expect(changed).toBe(true);
    expect(onCellChange).toHaveBeenCalledWith("update", "data", 0, {
      name: null,
    });
  });

  it("distinguishes an empty string from NULL", () => {
    const onCellChange = vi.fn();

    const changed = commitTableCellEdit({
      rowIdx: 0,
      columnName: "name",
      newValue: "",
      columns: [{ name: "name", db_type: "text" }],
      getRowArray: () => [{ t: "Null" }],
      patchHelpers: helpers,
      newRows: [],
      dataKey: "data",
      onCellChange,
    });

    expect(changed).toBe(true);
    expect(onCellChange).toHaveBeenCalledWith("update", "data", 0, {
      name: "",
    });
  });

  it("preserves significant whitespace changes", () => {
    const onCellChange = vi.fn();

    const changed = commitTableCellEdit({
      rowIdx: 0,
      columnName: "name",
      newValue: "value",
      columns: [{ name: "name", db_type: "text" }],
      getRowArray: () => [" value "],
      patchHelpers: helpers,
      newRows: [],
      dataKey: "data",
      onCellChange,
    });

    expect(changed).toBe(true);
  });

  it("does not create a patch when wrapped and edited values match", () => {
    const onCellChange = vi.fn();

    const changed = commitTableCellEdit({
      rowIdx: 0,
      columnName: "name",
      newValue: "value",
      columns: [{ name: "name", db_type: "text" }],
      getRowArray: () => [{ t: "Str", v: "value" }],
      patchHelpers: helpers,
      newRows: [],
      dataKey: "data",
      onCellChange,
    });

    expect(changed).toBe(false);
    expect(onCellChange).not.toHaveBeenCalled();
  });

  it("commits DEFAULT and keeps the new row identity", () => {
    const onCellChange = vi.fn();
    const newRowHelpers = {
      ...helpers,
      isNewRow: () => true,
      getRowKey: () => "new:0",
    };
    const value = defaultCellEditValue();

    commitTableCellEdit({
      rowIdx: 2,
      columnName: "created_at",
      newValue: value,
      columns: [{ name: "created_at", db_type: "timestamp" }],
      getRowArray: () => [null],
      patchHelpers: newRowHelpers,
      newRows: [],
      dataKey: "data",
      onCellChange,
    });

    expect(onCellChange).toHaveBeenCalledWith("create", "data", -1, {
      created_at: value,
      __rowKey: "new:0",
    });
  });

  it("blocks edits to read-only columns", () => {
    const onCellChange = vi.fn();

    const changed = commitTableCellEdit({
      rowIdx: 0,
      columnName: "generated_value",
      newValue: "changed",
      columns: [{ name: "generated_value", db_type: "text", readonly: true }],
      getRowArray: () => ["original"],
      patchHelpers: helpers,
      newRows: [],
      dataKey: "data",
      onCellChange,
    });

    expect(changed).toBe(false);
    expect(onCellChange).not.toHaveBeenCalled();
  });
});
