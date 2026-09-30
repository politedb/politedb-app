/**
 * Masked export policy types.
 * Masking reduces disclosure; it is not anonymization or a compliance claim.
 */

export const REDACTED_TEXT = "[REDACTED]" as const;

/** Synthetic marker used only in previews when Keep is explicit. */
export const SYNTHETIC_KEEP_VALUE = "ORIGINAL_VALUE" as const;

export type MaskRuleKind = "keep" | "redact" | "set_null" | "omit";

export type MaskingPolicy = {
  masked: boolean;
  selectedColumns: string[];
  /** Rule keyed by column name. Absent keys are invalid in masked mode. */
  rulesByColumn: Record<string, MaskRuleKind>;
};

export type MaskValidationError = {
  code:
    | "NO_SELECTED_COLUMNS"
    | "ZERO_OUTPUT_COLUMNS"
    | "MISSING_RULE"
    | "STALE_COLUMN"
    | "UNSUPPORTED_RULE"
    | "EMPTY_AVAILABLE";
  message: string;
  columnName?: string;
};

export type MaskValidationSuccess = {
  ok: true;
  outputColumns: string[];
};

export type MaskValidationFailure = {
  ok: false;
  error: MaskValidationError;
};

export type TransformError = {
  code: "SCHEMA_MISMATCH" | "UNSUPPORTED_RULE" | "TRANSFORM_FAILED";
  message: string;
  columnName?: string;
};
