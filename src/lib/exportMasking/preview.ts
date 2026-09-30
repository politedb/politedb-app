import { SYNTHETIC_KEEP_VALUE, type MaskingPolicy } from "./types";
import { REDACTED_TEXT } from "./types";
import { listOutputColumns } from "./policy";
import { transformExportChunk } from "./transform";
import { isNullCell } from "./cells";

/**
 * Build a one-row synthetic preview using the production transform helper.
 * Not live customer data.
 */
export function buildSyntheticPreview(args: {
  policy: MaskingPolicy;
  column: string;
}):
  | { ok: true; columns: string[]; rows: unknown[][] }
  | { ok: false; error: { message: string } } {
  const { policy } = args;
  const cols = [...policy.selectedColumns];
  if (cols.length === 0) {
    return { ok: false, error: { message: "No columns" } };
  }

  const row = cols.map((name) => {
    const rule = policy.rulesByColumn[name] ?? "keep";
    if (rule === "keep") {
      return { t: "Str" as const, v: SYNTHETIC_KEEP_VALUE };
    }
    // Non-keep samples still use a placeholder string (will be redacted/nulled).
    return { t: "Str" as const, v: "sample@example.com" };
  });

  // Preview transforms full selected width so Omit can drop columns.
  const result = transformExportChunk({
    policy,
    chunkColumns: cols,
    rows: [row],
    expectedProjectedColumns: cols,
  });

  if (!result.ok) {
    return { ok: false, error: { message: result.error.message } };
  }
  return result;
}

export function formatPreviewCell(cell: unknown): string {
  if (cell === undefined) return "(omitted)";
  if (isNullCell(cell)) return "null";
  if (typeof cell === "object" && cell !== null) {
    const t = (cell as { t?: string; v?: unknown }).t;
    if (t === "Str" && (cell as { v?: unknown }).v === REDACTED_TEXT) {
      return REDACTED_TEXT;
    }
    if ("v" in (cell as object)) {
      return String((cell as { v: unknown }).v ?? "");
    }
  }
  return String(cell);
}

export { listOutputColumns };
