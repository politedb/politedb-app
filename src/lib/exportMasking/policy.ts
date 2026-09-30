import type {
  MaskingPolicy,
  MaskRuleKind,
  MaskValidationFailure,
  MaskValidationSuccess,
} from "./types";

const SUPPORTED: ReadonlySet<MaskRuleKind> = new Set([
  "keep",
  "redact",
  "set_null",
  "omit",
]);

export function isMaskRuleKind(value: unknown): value is MaskRuleKind {
  return (
    value === "keep" ||
    value === "redact" ||
    value === "set_null" ||
    value === "omit"
  );
}

/** Deep-freeze-friendly copy of a policy (no shared mutable aliases). */
export function freezePolicy(policy: MaskingPolicy): MaskingPolicy {
  return {
    masked: policy.masked,
    selectedColumns: [...policy.selectedColumns],
    rulesByColumn: { ...policy.rulesByColumn },
  };
}

/** Default export policy: every selected column Keep (passthrough). */
export function buildDefaultMaskedPolicy(
  selectedColumns: string[]
): MaskingPolicy {
  const rulesByColumn: Record<string, MaskRuleKind> = {};
  for (const name of selectedColumns) {
    rulesByColumn[name] = "keep";
  }
  return {
    masked: true,
    selectedColumns: [...selectedColumns],
    rulesByColumn,
  };
}

/** Ordinary export policy: Keep all selected columns (no masking). */
export function ordinaryPolicy(selectedColumns: string[]): MaskingPolicy {
  const rulesByColumn: Record<string, MaskRuleKind> = {};
  for (const name of selectedColumns) {
    rulesByColumn[name] = "keep";
  }
  return {
    masked: false,
    selectedColumns: [...selectedColumns],
    rulesByColumn,
  };
}

export function withColumnRule(
  policy: MaskingPolicy,
  columnName: string,
  rule: MaskRuleKind
): MaskingPolicy {
  return freezePolicy({
    ...policy,
    rulesByColumn: { ...policy.rulesByColumn, [columnName]: rule },
  });
}

/**
 * Validate policy against available table columns.
 * Fail closed on missing/stale rules; never fallback Keep.
 * In ordinary mode, empty selection falls back to all available columns.
 */
export function validateMaskingPolicy(
  policy: MaskingPolicy,
  availableColumns: string[]
): MaskValidationSuccess | MaskValidationFailure {
  if (availableColumns.length === 0) {
    return {
      ok: false,
      error: {
        code: "EMPTY_AVAILABLE",
        message: "No columns available to export.",
      },
    };
  }

  const available = new Set(availableColumns);
  let selected = policy.selectedColumns;

  if (!policy.masked) {
    if (selected.length === 0) {
      selected = [...availableColumns];
    }
  } else if (selected.length === 0) {
    return {
      ok: false,
      error: {
        code: "NO_SELECTED_COLUMNS",
        message: "Select at least one column for masked export.",
      },
    };
  }

  for (const name of selected) {
    if (!available.has(name)) {
      return {
        ok: false,
        error: {
          code: "STALE_COLUMN",
          message: "A selected column is no longer available.",
          columnName: name,
        },
      };
    }
  }

  if (policy.masked) {
    for (const name of Object.keys(policy.rulesByColumn)) {
      if (!selected.includes(name)) {
        return {
          ok: false,
          error: {
            code: "STALE_COLUMN",
            message: "Mask rule refers to a column that is not selected.",
            columnName: name,
          },
        };
      }
    }

    for (const name of selected) {
      const rule = policy.rulesByColumn[name];
      if (rule == null) {
        return {
          ok: false,
          error: {
            code: "MISSING_RULE",
            message: "Every selected column needs an explicit mask rule.",
            columnName: name,
          },
        };
      }
      if (!isMaskRuleKind(rule) || !SUPPORTED.has(rule)) {
        return {
          ok: false,
          error: {
            code: "UNSUPPORTED_RULE",
            message: "Unsupported mask rule.",
            columnName: name,
          },
        };
      }
    }
  }

  const outputColumns = selected.filter((name) => {
    const rule = policy.rulesByColumn[name] ?? "keep";
    return rule !== "omit";
  });

  if (policy.masked && outputColumns.length === 0) {
    return {
      ok: false,
      error: {
        code: "ZERO_OUTPUT_COLUMNS",
        message:
          "Masked export needs at least one output column. Select at least one column to include.",
      },
    };
  }

  if (!policy.masked && outputColumns.length === 0) {
    return {
      ok: false,
      error: {
        code: "NO_SELECTED_COLUMNS",
        message: "No columns to export.",
      },
    };
  }

  return { ok: true, outputColumns };
}

export function listKeepColumns(policy: MaskingPolicy): string[] {
  if (!policy.masked) return [];
  return policy.selectedColumns.filter(
    (name) => policy.rulesByColumn[name] === "keep"
  );
}

export function listOutputColumns(policy: MaskingPolicy): string[] {
  return policy.selectedColumns.filter(
    (name) => (policy.rulesByColumn[name] ?? "keep") !== "omit"
  );
}

/** Sync selected columns into a policy (new cols → keep). */
export function syncMaskedSelection(
  policy: MaskingPolicy | null,
  selectedColumns: string[]
): MaskingPolicy {
  const prev = policy?.rulesByColumn ?? {};
  const rulesByColumn: Record<string, MaskRuleKind> = {};
  for (const name of selectedColumns) {
    rulesByColumn[name] = prev[name] ?? "keep";
  }
  return {
    masked: true,
    selectedColumns: [...selectedColumns],
    rulesByColumn,
  };
}

/** True when any selected column applies a non-passthrough treatment. */
export function policyHasActiveMasking(policy: MaskingPolicy): boolean {
  return policy.selectedColumns.some((name) => {
    const rule = policy.rulesByColumn[name];
    return rule != null && rule !== "keep";
  });
}
