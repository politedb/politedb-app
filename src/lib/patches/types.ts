import type { RecordedRows } from "./rowPositionPatches";
import type {
  DataAction,
  DataKey,
  TableDataState,
} from "src/stores/connection";
import type { TableWindow } from "src/types";

export type WindowPatchBuckets = Partial<
  Record<DataAction, Partial<Record<DataKey, Record<string, unknown>>>>
>;

export type PatchMapEntry = {
  tableData?: TableDataState;
  tableWindow: TableWindow;
  patches: WindowPatchBuckets;
  /** Rows that unsaved row edits and deletions target (see rowPositionPatches). */
  originalRows?: RecordedRows;
};

export type PatchApplyContext = {
  activeProfileScreen: string;
  runtimeConnectionId: string;
  offset: number;
};

export function mongoCellToValue(cell: unknown): unknown {
  if (cell == null) return null;
  if (typeof cell !== "object") return cell;

  const c = cell as { t?: string; v?: unknown };
  switch (c.t) {
    case "Null":
      return null;
    case "Str":
    case "Json":
    case "BytesB64":
    case "I64":
    case "F64":
    case "Bool":
      return c.v ?? null;
    default:
      if ("v" in c) return c.v ?? null;
      return cell;
  }
}

export function patchValueToString(
  value: unknown,
  mongoCellToValueFn: (cell: unknown) => unknown = mongoCellToValue
): string {
  if (value == null) return "";
  if (typeof value === "object" && value !== null && "t" in value) {
    const plain = mongoCellToValueFn(value);
    if (plain == null) return "";
    return String(plain);
  }
  return String(value);
}

/**
 * The row a row patch targets: the row recorded when it was made, else (older
 * patches) the row now loaded at its page position.
 */
function resolveRowIndex(
  rowKey: string,
  offset: number,
  key: string,
  store: ReturnType<
    typeof import("src/stores/connection").useConnectionStore.getState
  >,
  recorded?: unknown[]
) {
  const rowIndex = Number(rowKey);
  if (!Number.isFinite(rowIndex) || rowIndex < 0) return null;

  if (recorded) return { resolvedIndex: rowIndex, sourceRow: recorded };

  const cache = store.tableRowCacheByKey[key];
  const candidateIndices = [rowIndex, rowIndex + offset];
  const resolvedIndex =
    candidateIndices.find(
      (idx) => Boolean(cache?.map.get(idx)) || Boolean(store.getRowAt(key, idx))
    ) ?? rowIndex;

  const originalRow = cache?.map.get(resolvedIndex);
  const fallbackRow = store.getRowAt(key, resolvedIndex);
  const sourceRow = Array.isArray(originalRow) ? originalRow : fallbackRow;
  if (!sourceRow || !Array.isArray(sourceRow)) return null;

  return { resolvedIndex, sourceRow };
}

export { resolveRowIndex };
