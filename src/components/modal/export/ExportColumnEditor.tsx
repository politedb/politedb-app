import { useMemo, useState } from "preact/hooks";
import { Checkbox } from "src/components/common/Checkbox";
import { Input } from "src/components/common/Input";
import { Select } from "src/components/common/Select";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import { cn } from "src/utils/cn";
import {
  buildSyntheticPreview,
  formatPreviewCell,
  type MaskingPolicy,
  type MaskRuleKind,
} from "src/lib/export-masking";
import { SearchIcon } from "src/components/icons";
import { Tooltip } from "src/components/common/Tooltip";

const RULE_OPTIONS: { value: MaskRuleKind; label: string }[] = [
  { value: "keep", label: "Keep original" },
  { value: "redact", label: "Redact" },
  { value: "set_null", label: "Set null" },
];

export type ExportColumnEditorProps = {
  columnNames: string[];
  selectedColumns: string[];
  policy: MaskingPolicy | null;
  /** Shows the per-column treatment and preview; otherwise a plain column picker. */
  maskingEnabled: boolean;
  disabled?: boolean;
  selectedCount: number;
  outputCount: number;
  onToggleColumn: (name: string) => void;
  onToggleSelectAll: () => void;
  onRuleChange: (name: string, rule: MaskRuleKind) => void;
};

export function ExportColumnEditor({
  columnNames,
  selectedColumns,
  policy,
  maskingEnabled,
  disabled,
  selectedCount,
  onToggleColumn,
  onToggleSelectAll,
  onRuleChange,
}: ExportColumnEditorProps) {
  const [columnSearch, setColumnSearch] = useState("");
  const [expandedPreview, setExpandedPreview] = useState<string | null>(null);

  const selectedSet = useMemo(
    () => new Set(selectedColumns),
    [selectedColumns]
  );

  const filteredColumnNames = useMemo(() => {
    const q = columnSearch.trim().toLowerCase();
    if (!q) return columnNames;
    return columnNames.filter((name) => name.toLowerCase().includes(q));
  }, [columnNames, columnSearch]);

  const allSelected =
    columnNames.length > 0 && selectedCount === columnNames.length;
  const noneSelected = selectedCount === 0;
  const mixedSelected = !allSelected && !noneSelected;

  const previewByColumn = useMemo(() => {
    const map: Record<string, string> = {};
    if (!policy) return map;
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

  const gridCols = maskingEnabled
    ? "grid-cols-[auto_minmax(0,1fr)_9.5rem] sm:grid-cols-[auto_minmax(0,1fr)_9.5rem_minmax(5rem,8rem)]"
    : "grid-cols-[auto_minmax(0,1fr)]";

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2">
      <div class="flex shrink-0 flex-wrap items-center gap-2">
        <div class="min-w-0 flex-1">
          <Input
            type="text"
            value={columnSearch}
            onValueChange={setColumnSearch}
            disabled={disabled}
            placeholder="Search columns"
            aria-label="Search columns"
            className="h-8 rounded-md"
            left={<SearchIcon className="size-4" />}
          />
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-neutral-200">
        <div
          class={cn(
            "grid shrink-0 gap-2 border-b border-neutral-200 bg-neutral-50 p-2 text-xs font-bold tracking-wide",
            "text-neutral-500 uppercase dark:bg-neutral-900/80",
            gridCols
          )}
        >
          <Checkbox
            checked={allSelected}
            indeterminate={mixedSelected}
            disabled={disabled || columnNames.length === 0}
            onChange={onToggleSelectAll}
            aria-label={`Select all ${columnNames.length} columns`}
            title="Applies to every column, not only search matches"
          />
          <span>Column</span>
          {maskingEnabled ? (
            <>
              <span>Treatment</span>
              <span
                class="hidden truncate sm:block"
                title="Synthetic preview — not live data"
              >
                Preview
              </span>
            </>
          ) : null}
        </div>

        <OverlayScrollArea
          className="max-h-96 min-h-0 flex-1"
          contentClassName="divide-y divide-neutral-100 dark:divide-neutral-800"
        >
          {filteredColumnNames.length === 0 ? (
            <div class="px-3 py-6 text-center text-sm text-neutral-500">
              No columns found. Try a different search.
            </div>
          ) : (
            filteredColumnNames.map((name) => {
              const selected = selectedSet.has(name);
              const rule =
                (policy?.rulesByColumn[name] as MaskRuleKind | undefined) ??
                "keep";
              // Kept columns show their real data: no synthetic preview to offer.
              const preview =
                rule === "keep" ? "—" : (previewByColumn[name] ?? "—");
              const previewOpen = expandedPreview === name;

              return (
                <div
                  key={name}
                  class={cn("grid h-10 items-center gap-2 px-2 py-1", gridCols)}
                >
                  <Checkbox
                    checked={selected}
                    disabled={disabled}
                    onChange={() => onToggleColumn(name)}
                    aria-label={`Include column ${name}`}
                  />
                  <div class="flex h-8 min-w-0 items-center gap-1.5">
                    <span
                      class="truncate font-mono text-xs text-neutral-800"
                      title={name}
                    >
                      {name}
                    </span>
                    {maskingEnabled && selected && rule !== "keep" && (
                      <button
                        type="button"
                        class="ml-auto text-xs text-neutral-500 underline sm:hidden"
                        disabled={disabled}
                        aria-expanded={previewOpen}
                        onClick={() =>
                          setExpandedPreview(previewOpen ? null : name)
                        }
                      >
                        Preview
                      </button>
                    )}
                  </div>
                  {maskingEnabled ? (
                    <>
                      <Select
                        value={selected ? rule : "keep"}
                        disabled={disabled || !selected}
                        className="h-8 w-full"
                        aria-label={`Treatment for ${name}`}
                        onChange={(e) => {
                          const nextRule = e.currentTarget
                            .value as MaskRuleKind;
                          onRuleChange(name, nextRule);
                        }}
                      >
                        {RULE_OPTIONS.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </Select>
                      <span
                        class="hidden truncate font-mono text-xs text-neutral-600 sm:block"
                        title="Synthetic preview (not live data)"
                      >
                        {selected ? preview : "—"}
                      </span>
                    </>
                  ) : null}
                  {maskingEnabled && selected && previewOpen && (
                    <div
                      class={cn(
                        "col-span-full rounded border border-neutral-200 bg-neutral-50 px-2 py-1 font-mono text-[10px]",
                        "text-neutral-600 sm:hidden dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
                      )}
                    >
                      <span class="text-neutral-400">Synthetic: </span>
                      {preview}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </OverlayScrollArea>
      </div>

      {maskingEnabled ? (
        <p className="flex flex-wrap gap-x-2 gap-y-0.5 text-xs text-neutral-500 dark:text-neutral-400">
          <span>
            Redact or null a column per row; the preview is synthetic.
          </span>
          <Tooltip
            className="w-fit"
            align="center"
            side="top"
            content="Masking reduces data exposure but does not guarantee anonymization or regulatory compliance. Null values are exported as NULL in CSV and null in JSON. Does not modify the database."
          >
            <span className="cursor-help underline decoration-dotted">
              Notes
            </span>
          </Tooltip>
        </p>
      ) : null}
    </div>
  );
}
