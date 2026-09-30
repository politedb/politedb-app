import type { CellValue } from "src/utils/convert";
import { REDACTED_TEXT, type MaskRuleKind } from "./types";

export function isNullCell(cell: unknown): boolean {
  if (cell == null) return true;
  if (typeof cell === "object" && (cell as { t?: unknown }).t === "Null") {
    return true;
  }
  return false;
}

export function copyCell(cell: unknown): unknown {
  if (cell == null) return cell;
  if (typeof cell !== "object") return cell;
  const tagged = cell as CellValue & Record<string, unknown>;
  if (typeof tagged.t === "string") {
    if (tagged.t === "Null") return { t: "Null" };
    if ("v" in tagged) return { t: tagged.t, v: tagged.v };
  }
  if (Array.isArray(cell)) return cell.slice();
  return { ...(tagged as Record<string, unknown>) };
}

export function nullCell(): CellValue {
  return { t: "Null" };
}

export function redactCell(): CellValue {
  return { t: "Str", v: REDACTED_TEXT };
}

/** Apply one mask rule to a single cell (production helper). */
export function applyMaskRule(cell: unknown, rule: MaskRuleKind): unknown {
  switch (rule) {
    case "keep":
      return copyCell(cell);
    case "redact":
      return isNullCell(cell) ? nullCell() : redactCell();
    case "set_null":
      return nullCell();
    case "omit":
      return undefined;
    default:
      throw new Error("Unsupported mask rule");
  }
}
