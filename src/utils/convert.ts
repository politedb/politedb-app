// types.ts (FE)
export type CellValue =
  | { t: "Null" }
  | { t: "Str"; v: string }
  | { t: "Json"; v: string }
  | { t: "I64"; v: number }
  | { t: "F64"; v: number }
  | { t: "Bool"; v: boolean }
  | { t: "BytesB64"; v: string };

// utils
export function cellToString(cell: any): string {
  if (cell == null) return "";

  if (
    typeof cell === "string" ||
    typeof cell === "number" ||
    typeof cell === "boolean"
  ) {
    return String(cell);
  }

  if (typeof cell === "object") {
    // { t: "Str", v: "public" }
    if ("v" in cell) return String((cell as any).v ?? "");
    // { t: "Null" }
    if ((cell as any).t === "Null") return "";
  }

  return "";
}
