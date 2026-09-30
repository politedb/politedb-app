import { useMemo } from "preact/hooks";
import { Select } from "src/components/common/Select";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import {
  buildSyntheticPreview,
  formatPreviewCell,
  listKeepColumns,
  type MaskingPolicy,
  type MaskRuleKind,
  withColumnRule,
} from "src/lib/exportMasking";

const RULE_OPTIONS: { value: MaskRuleKind; label: string }[] = [
  { value: "redact", label: "Redact" },
  { value: "set_null", label: "Set null" },
  { value: "omit", label: "Omit" },
  { value: "keep", label: "Keep original" },
];

type Props = {
  policy: MaskingPolicy;
  disabled?: boolean;
  onChange: (next: MaskingPolicy) => void;
};

export function MaskedColumnRules({ policy, disabled, onChange }: Props) {
  const keepColumns = useMemo(() => listKeepColumns(policy), [policy]);

  const previewByColumn = useMemo(() => {
    const map: Record<string, string> = {};
    for (const col of policy.selectedColumns) {
      const result = buildSyntheticPreview({ policy, column: col });
      if (!result.ok) {
        map[col] = "—";
        continue;
      }
      const idx = result.columns.indexOf(col);
      if (idx < 0) {
        map[col] = "(omitted)";
        continue;
      }
      map[col] = formatPreviewCell(result.rows[0]?.[idx]);
    }
    return map;
  }, [policy]);

  return (
    <div class="space-y-2">
      <div class="flex items-center justify-between gap-2">
        <label class="block text-sm font-medium text-neutral-600 dark:text-neutral-300">
          Column masking rules
        </label>
        <span class="text-xs text-blue-700">Defaults to Redact</span>
      </div>
      <OverlayScrollArea
        className="max-h-48 rounded-md border border-amber-200 bg-amber-50/40 dark:border-amber-800 dark:bg-amber-950/30"
        contentClassName="divide-y divide-amber-100 dark:divide-amber-900"
      >
        {policy.selectedColumns.length === 0 ? (
          <div class="p-3 text-sm text-neutral-500">
            Select at least one column for masked export.
          </div>
        ) : (
          policy.selectedColumns.map((name) => {
            const rule = policy.rulesByColumn[name] ?? "redact";
            return (
              <div key={name} class="flex flex-wrap items-center gap-2 p-1">
                <span class="min-w-0 flex-1 truncate font-mono text-xs text-neutral-800 dark:text-neutral-100">
                  {name}
                </span>
                <Select
                  value={rule}
                  disabled={disabled}
                  className="h-8 w-36 text-xs!"
                  onChange={(e) => {
                    const nextRule = e.currentTarget.value as MaskRuleKind;
                    onChange(withColumnRule(policy, name, nextRule));
                  }}
                >
                  {RULE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </Select>
                <span
                  class="w-28 truncate text-right font-mono text-[10px] text-neutral-500 dark:text-neutral-400"
                  title="Synthetic preview (not live data)"
                >
                  {previewByColumn[name]}
                </span>
              </div>
            );
          })
        )}
      </OverlayScrollArea>
      <p class="text-xs text-neutral-500 dark:text-neutral-400">
        Preview uses synthetic values only (same transform as export). CSV nulls
        are written as the token NULL; JSON uses null. Masking reduces
        disclosure — not anonymization or compliance.
      </p>
      {keepColumns.length > 0 && (
        <div class="rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <span class="font-semibold">
            Keeping original values for {keepColumns.length} column
            {keepColumns.length === 1 ? "" : "s"}:{" "}
          </span>
          <span class="font-mono">{keepColumns.join(", ")}</span>
        </div>
      )}
    </div>
  );
}
