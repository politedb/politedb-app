import type { LoadFlags } from "src/lib/table-data";
import type { TableSort } from "src/lib/queries/sql";
import type { TableFilterState } from "src/stores/connection";

export function buildTableReloadQueryFlags(
  flags: LoadFlags,
  filterState: TableFilterState | undefined,
  sortBy: TableSort | null | undefined
): LoadFlags {
  const appliedFilters = filterState?.appliedFilters ?? [];
  const hasAppliedFilters = appliedFilters.some(
    (filter) => filter.enabled && Boolean((filter.column ?? "").trim())
  );

  return {
    ...flags,
    filters: hasAppliedFilters ? appliedFilters : undefined,
    filterCombine: filterState?.appliedFilterCombine ?? "AND",
    sortBy: sortBy ?? null,
  };
}
