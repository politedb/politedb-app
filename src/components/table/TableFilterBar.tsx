import { Fragment } from "preact";
import { useCallback, useEffect, useMemo, useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Select } from "src/components/common/Select";
import { PlusIcon, ChevronDownIcon, MinusIcon } from "src/components/icons";
import type { ColumnMeta } from "src/lib/tauri/types";
import type { TableFilterCondition, TableSort } from "src/hooks/queries";
import {
  FILTER_OPERATORS,
  normalizeFilterOperator,
  isListFilterOperator,
  isNullFilterOperator,
  isRangeFilterOperator,
  tableDataQuery,
} from "src/hooks/queries";
import { cn } from "src/utils/cn";
import { Input } from "src/components/common/Input";
import { Checkbox } from "src/components/common/Checkbox";

interface TableFilterBarProps {
  tableKey: string;
  schema: string;
  tableName: string;
  columns: ColumnMeta[];
  filters: TableFilterCondition[];
  filterCombine: "AND" | "OR";
  appliedFilters: TableFilterCondition[];
  limit: number;
  offset: number;
  sortState?: TableSort | null;
  onFiltersChange: (filters: TableFilterCondition[]) => void;
  onFilterCombineChange: (combine: "AND" | "OR") => void;
  onApply: (
    filters: TableFilterCondition[],
    combine: "AND" | "OR",
    tableKey: string
  ) => void;
  onClear: (visible?: boolean) => void;
  setFilterVisible: (
    visible: boolean | ((prev: boolean) => boolean),
    tableKey: string
  ) => void;
  onExport?: () => void;
  onImport?: () => void;
  onShowSql?: (sql: string) => void;
  /** Last table load failed — highlight value inputs */
  queryError?: boolean;
}

export function TableFilterBar({
  tableKey,
  schema,
  tableName,
  columns,
  filters,
  filterCombine,
  appliedFilters,
  limit,
  offset,
  sortState = null,
  onFiltersChange,
  onFilterCombineChange,
  onApply,
  onClear,
  onExport,
  onShowSql,
  queryError = false,
}: TableFilterBarProps) {
  const [applyAllOpen, setApplyAllOpen] = useState(false);

  const columnNames = useMemo(
    () => columns.map((c) => c.name).filter(Boolean),
    [columns]
  );

  const defaultFilter = useMemo(() => {
    return {
      id: 0,
      column: columns[0]?.name ?? "",
      operator: "=",
      value: "",
      enabled: true,
    };
  }, [columns[0]?.name]);

  const addRow = useCallback(() => {
    onFiltersChange([...filters, { ...defaultFilter, id: filters.length }]);
  }, [filters, defaultFilter, onFiltersChange]);

  const removeRow = useCallback(
    (index: number) => {
      if (filters.length <= 1) {
        onClear(false);
        return;
      }
      onFiltersChange(filters.filter((_, i) => i !== index));
    },
    [filters, onFiltersChange, onClear]
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
      onApply(filters, combine, tableKey);
    },
    [filters, onApply, onFilterCombineChange, tableKey]
  );

  const handleApplyRow = useCallback(
    (row: TableFilterCondition) => {
      onApply([row], filterCombine, tableKey);
    },
    [filterCombine, onApply, tableKey]
  );

  const checkFilterApplied = useCallback(
    (filter: TableFilterCondition) => {
      const filterApplied = appliedFilters.find((f) => f.id === filter.id);
      return (
        filterApplied &&
        filterApplied.enabled &&
        Boolean((filterApplied.column ?? "").trim())
      );
    },
    [appliedFilters]
  );

  const currentSql = useMemo(() => {
    const enabled = filters.filter((f) => f.enabled && (f.column ?? "").trim());
    if (enabled.length === 0) return null;
    return tableDataQuery(
      schema,
      tableName,
      { limit, offset },
      filters,
      filterCombine,
      sortState
    );
  }, [schema, tableName, limit, offset, filters, filterCombine, sortState]);

  useEffect(() => {
    if (filters.length > 0) return;
    onFiltersChange([defaultFilter]);
  }, [defaultFilter, filters.length, onFiltersChange]);

  return (
    <div class="flex flex-col gap-2.5 border-t border-neutral-200 bg-neutral-50 px-4 py-3">
      {/* Filter row(s) */}
      <div class="flex flex-col gap-2">
        {filters.map((row, index) => {
          const isAppliedFilter = checkFilterApplied(row);

          return (
            <div key={index} class="flex items-center gap-2">
              <Checkbox
                checked={row.enabled}
                onChange={(e) =>
                  updateRow(index, {
                    enabled: (e.target as HTMLInputElement).checked,
                  })
                }
              />
              <Select
                value={row.column}
                onChange={(e) =>
                  updateRow(index, {
                    column: (e.target as HTMLSelectElement).value,
                  })
                }
                class="h-7 w-36 border-neutral-300 text-center text-sm! [text-align-last:center]"
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
                    operator: normalizeFilterOperator(
                      (e.target as HTMLSelectElement).value
                    ),
                  })
                }
                class="h-7 w-36 border-neutral-300 text-center text-sm! [text-align-last:center]"
              >
                {FILTER_OPERATORS.map((op) => (
                  <Fragment key={op.value}>
                    <option
                      key={op.value}
                      value={op.value}
                      disabled={op.type === "separator"}
                    >
                      {op.type === "separator" ? "────────" : op.value}
                    </option>
                  </Fragment>
                ))}
              </Select>
              <div class="flex-1">
                <Input
                  type="text"
                  placeholder={
                    isNullFilterOperator(row.operator)
                      ? ""
                      : isRangeFilterOperator(row.operator)
                        ? "min, max"
                        : isListFilterOperator(row.operator)
                          ? "value1, value2, ..."
                          : "EMPTY"
                  }
                  value={isNullFilterOperator(row.operator) ? "" : row.value}
                  disabled={isNullFilterOperator(row.operator)}
                  onInput={(e) =>
                    updateRow(index, {
                      value: (e.target as HTMLInputElement).value,
                    })
                  }
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    handleApplyRow(row);
                    (e.currentTarget as HTMLInputElement).blur();
                  }}
                  className={cn(
                    "min-w-[140px] flex-1 px-3 py-[2.5px] text-sm outline-none",
                    "border border-neutral-300 bg-white focus:border-blue-400",
                    queryError &&
                      "border-red-300 bg-red-100! focus:border-red-400",
                    !queryError && isAppliedFilter && "bg-green-100!"
                  )}
                />
              </div>

              <Button
                variant="shadow"
                className="px-3 py-[4.5px] text-xs"
                onClick={() => handleApplyRow(row)}
              >
                Apply
              </Button>
              <Button
                variant="shadow"
                className="p-[6.5px] text-xs"
                onClick={() => removeRow(index)}
                aria-label="Remove filter"
              >
                <MinusIcon className="size-2.5" />
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
                <PlusIcon className="size-2.5" />
              </Button>
            </div>
          );
        })}
      </div>

      {/* Action row */}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          {onExport && (
            <Button
              variant="shadow"
              className="px-3 text-xs"
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
            <Button
              variant="shadow"
              className="px-3 text-xs"
              onClick={() => onClear(true)}
            >
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
                  <ChevronDownIcon className="size-3.5" />
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
