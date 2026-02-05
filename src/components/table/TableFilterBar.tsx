import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Select } from "src/components/common/Select";
import { Plus, ChevronDown, Minus } from "src/components/icons";
import type { ColumnMeta } from "src/lib/tauri/types";
import type { TableFilterCondition } from "src/hooks/queries";
import { tableDataQuery } from "src/hooks/queries";
import { cn } from "src/utils/cn";
import { Input } from "src/components/common/Input";

const OPERATORS = [
  "=",
  "!=",
  "<>",
  "<",
  ">",
  "<=",
  ">=",
  "LIKE",
  "ILIKE",
  "IN",
  "NOT IN",
  "IS NULL",
  "IS NOT NULL",
];

const NULL_OPS = ["IS NULL", "IS NOT NULL"];
const LIST_OPS = ["IN", "NOT IN"];

interface TableFilterBarProps {
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  filters: TableFilterCondition[];
  filterCombine: "AND" | "OR";
  limit: number;
  offset: number;
  onFiltersChange: (filters: TableFilterCondition[]) => void;
  onFilterCombineChange: (combine: "AND" | "OR") => void;
  onApply: (filters: TableFilterCondition[], combine: "AND" | "OR") => void;
  onClear: () => void;
  onExport?: () => void;
  onShowSql?: (sql: string) => void;
}

export function TableFilterBar({
  schema,
  tableName,
  columns,
  filters,
  filterCombine,
  limit,
  offset,
  onFiltersChange,
  onFilterCombineChange,
  onApply,
  onClear,
  onExport,
  onShowSql,
}: TableFilterBarProps) {
  const [applyAllOpen, setApplyAllOpen] = useState(false);

  const columnNames = useMemo(
    () => columns.map((c) => c.name).filter(Boolean),
    [columns]
  );

  const defaultFilter = useMemo(() => {
    return {
      column: columns[0]?.name ?? "",
      operator: "=",
      value: "",
      enabled: true,
    };
  }, [columns[0]?.name]);

  const addRow = useCallback(() => {
    onFiltersChange([...filters, defaultFilter]);
  }, [filters, onFiltersChange]);

  const removeRow = useCallback(
    (index: number) => {
      if (filters.length <= 1) {
        onFiltersChange([]);
        return;
      }
      onFiltersChange(filters.filter((_, i) => i !== index));
    },
    [filters, onFiltersChange]
  );

  const updateRow = useCallback(
    (index: number, patch: Partial<TableFilterCondition>) => {
      if (filters.length === 0) {
        onFiltersChange([{ ...defaultFilter, ...patch }]);
        return;
      }
      const next = [...filters];
      next[index] = { ...next[index]!, ...patch };
      onFiltersChange(next);
    },
    [filters, onFiltersChange]
  );

  const handleApplyAll = useCallback(
    (combine: "AND" | "OR") => {
      setApplyAllOpen(false);
      onFilterCombineChange(combine);
      onApply(filters, combine);
    },
    [filters, onApply, onFilterCombineChange]
  );

  const currentSql = useMemo(() => {
    const enabled = filters.filter((f) => f.enabled && (f.column ?? "").trim());
    if (enabled.length === 0) return null;
    return tableDataQuery(
      schema,
      tableName,
      { limit, offset },
      filters,
      filterCombine
    );
  }, [schema, tableName, limit, offset, filters, filterCombine]);

  useEffect(() => {
    if (filters.length > 0) return;
    onFiltersChange([defaultFilter]);
  }, [defaultFilter, filters.length, onFiltersChange]);

  return (
    <div class="flex flex-col gap-2.5 border-b border-neutral-200 bg-neutral-50 px-4 py-3">
      {/* Filter row(s) */}
      <div class="flex flex-col gap-2">
        {filters.map((row, index) => (
          <div key={index} class="flex items-center gap-2">
            <label class="flex cursor-pointer items-center">
              <input
                type="checkbox"
                checked={row.enabled}
                onChange={(e) =>
                  updateRow(index, {
                    enabled: (e.target as HTMLInputElement).checked,
                  })
                }
                class="h-4 w-4 rounded border-neutral-300 text-blue-600 focus:ring-blue-500"
              />
            </label>
            <Select
              value={row.column}
              onChange={(e) =>
                updateRow(index, {
                  column: (e.target as HTMLSelectElement).value,
                })
              }
              class="h-7 w-32 border-neutral-300"
            >
              {columnNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </Select>
            <Select
              value={row.operator}
              onChange={(e) =>
                updateRow(index, {
                  operator: (e.target as HTMLSelectElement).value,
                })
              }
              class="h-7 w-32 border-neutral-300 text-center"
            >
              {OPERATORS.map((op) => (
                <option key={op} value={op}>
                  {op}
                </option>
              ))}
            </Select>
            <div class="flex-1">
              <Input
                type="text"
                placeholder={
                  NULL_OPS.includes(row.operator)
                    ? ""
                    : LIST_OPS.includes(row.operator)
                      ? "value1, value2, ..."
                      : "EMPTY"
                }
                value={NULL_OPS.includes(row.operator) ? "" : row.value}
                disabled={NULL_OPS.includes(row.operator)}
                onInput={(e) =>
                  updateRow(index, {
                    value: (e.target as HTMLInputElement).value,
                  })
                }
                className={cn(
                  "min-w-[140px] flex-1 px-3 py-[2.5px] text-sm outline-none",
                  "border border-neutral-300 bg-white focus:border-blue-400"
                )}
              />
            </div>

            <Button
              variant="shadow"
              className="px-3 py-[4.5px] text-xs"
              onClick={() => onApply(filters, filterCombine)}
            >
              Apply
            </Button>
            <Button
              variant="shadow"
              className="p-[6.5px] text-xs"
              onClick={() => removeRow(index)}
              aria-label="Remove filter"
            >
              <Minus className="size-2.5" />
            </Button>
            <Button
              variant="shadow"
              className={cn(
                "invisible p-[6.5px] text-xs",
                index === 0 && "visible"
              )}
              onClick={addRow}
              aria-label="Add filter"
            >
              <Plus className="size-2.5" />
            </Button>
          </div>
        ))}
      </div>

      {/* Action row */}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          {onExport && (
            <Button
              variant="shadow"
              className="px-3 py-1.5 text-xs"
              onClick={onExport}
            >
              Export
            </Button>
          )}
          {onShowSql && currentSql && (
            <Button
              variant="shadow"
              className="px-3 text-xs"
              onClick={() => onShowSql(currentSql)}
            >
              SQL
            </Button>
          )}
        </div>
        {filters.length > 0 && (
          <div class="flex items-center gap-2">
            <Button variant="shadow" className="px-3 text-xs" onClick={onClear}>
              Clear
            </Button>
            <div class="relative">
              <Button variant="shadow" className="gap-0 p-0 text-xs">
                <div
                  class="py-1 pr-2 pl-3"
                  onClick={() => handleApplyAll("AND")}
                >
                  Apply All
                </div>
                <div
                  class="border-l border-neutral-200 px-1"
                  onClick={() => setApplyAllOpen(!applyAllOpen)}
                >
                  <ChevronDown className="size-3.5" />
                </div>
              </Button>
              {applyAllOpen && (
                <div class="z-50">
                  <div
                    class="fixed inset-0 z-10"
                    onClick={() => setApplyAllOpen(false)}
                    aria-hidden
                  />
                  <div class="absolute top-full right-0 z-20 mt-1 w-36 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
                    <button
                      type="button"
                      class="block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-100"
                      onClick={() => handleApplyAll("AND")}
                    >
                      AND
                    </button>
                    <button
                      type="button"
                      class="block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-100"
                      onClick={() => handleApplyAll("OR")}
                    >
                      OR
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
