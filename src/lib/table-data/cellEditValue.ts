export type DefaultCellEditValue = { __politedbCellEdit: "default" };
export type CellEditValue = string | null | DefaultCellEditValue;

export function defaultCellEditValue(): DefaultCellEditValue {
  return { __politedbCellEdit: "default" };
}

export function isDefaultCellEditValue(
  value: unknown
): value is DefaultCellEditValue {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { __politedbCellEdit?: unknown }).__politedbCellEdit === "default"
  );
}
