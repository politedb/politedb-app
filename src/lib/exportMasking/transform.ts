import { applyMaskRule, copyCell } from "./cells";
import type { MaskingPolicy, TransformError } from "./types";
import { listOutputColumns } from "./policy";

export type TransformExportChunkArgs = {
  policy: MaskingPolicy;
  chunkColumns: string[];
  rows: unknown[][];
  /** Expected SQL projection columns (selected minus omit for masked). */
  expectedProjectedColumns: string[];
};

export type TransformExportChunkResult =
  | { ok: true; columns: string[]; rows: unknown[][] }
  | { ok: false; error: TransformError };

function columnsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Transform a chunk under a frozen policy.
 * Copies cells; never mutates source rows. Fail closed on schema mismatch.
 */
export function transformExportChunk(
  args: TransformExportChunkArgs
): TransformExportChunkResult {
  const { policy, chunkColumns, rows, expectedProjectedColumns } = args;

  if (!columnsEqual(chunkColumns, expectedProjectedColumns)) {
    return {
      ok: false,
      error: {
        code: "SCHEMA_MISMATCH",
        message: "Chunk column names or order do not match export projection.",
      },
    };
  }

  const outputColumns = listOutputColumns(policy);
  // When omit is applied in SQL, projected === output. When transforming
  // full selected width (preview), projected may equal selectedColumns.
  const usingSelected = columnsEqual(chunkColumns, policy.selectedColumns);
  const usingProjected = columnsEqual(chunkColumns, outputColumns);

  if (!usingSelected && !usingProjected) {
    // expectedProjectedColumns matched chunkColumns above; if that equals
    // neither selected nor output, schema is inconsistent with policy.
    if (
      !columnsEqual(expectedProjectedColumns, outputColumns) &&
      !columnsEqual(expectedProjectedColumns, policy.selectedColumns)
    ) {
      return {
        ok: false,
        error: {
          code: "SCHEMA_MISMATCH",
          message: "Chunk columns do not match the frozen mask policy.",
        },
      };
    }
  }

  const mapFrom = chunkColumns;

  try {
    const outRows: unknown[][] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length !== mapFrom.length) {
        return {
          ok: false,
          error: {
            code: "SCHEMA_MISMATCH",
            message: "Row width does not match chunk columns.",
          },
        };
      }
      const out: unknown[] = [];
      for (let i = 0; i < mapFrom.length; i++) {
        const name = mapFrom[i]!;
        const rule =
          policy.rulesByColumn[name] ?? (policy.masked ? undefined : "keep");
        if (rule == null) {
          return {
            ok: false,
            error: {
              code: "UNSUPPORTED_RULE",
              message: "Missing rule for column.",
              columnName: name,
            },
          };
        }
        if (rule === "omit") continue;
        try {
          if (!policy.masked && rule === "keep") {
            out.push(copyCell(row[i]));
          } else {
            out.push(applyMaskRule(row[i], rule));
          }
        } catch {
          return {
            ok: false,
            error: {
              code: "UNSUPPORTED_RULE",
              message: "Unsupported mask rule during transform.",
              columnName: name,
            },
          };
        }
      }
      if (out.length !== outputColumns.length) {
        return {
          ok: false,
          error: {
            code: "TRANSFORM_FAILED",
            message: "Transformed row width mismatch.",
          },
        };
      }
      outRows.push(out);
    }
    return { ok: true, columns: [...outputColumns], rows: outRows };
  } catch {
    return {
      ok: false,
      error: {
        code: "TRANSFORM_FAILED",
        message: "Masked export transformation failed.",
      },
    };
  }
}
