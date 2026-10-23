/**
 * How many loaded rows the table grid shows for the current page.
 * `basePageTotal` is the page size bounded by an exact count (the plain page
 * size for an estimate); it stands in while rows load, never for a settled page.
 */
export function pageRowCount(args: {
  hasRowsWindow: boolean;
  hasAppliedFilters: boolean;
  rowCount: number | null | undefined;
  loadedRowCount: number;
  basePageTotal: number;
  rowsSettled: boolean;
}): number {
  const {
    hasRowsWindow,
    hasAppliedFilters,
    rowCount,
    loadedRowCount,
    basePageTotal,
    rowsSettled,
  } = args;
  if (!hasRowsWindow) return 0;

  if (hasAppliedFilters) {
    // When filters are applied, rowCount is the source of truth for the
    // filtered result size. loadedRowCount may still reflect stale rows from
    // a previous unfiltered window while new chunks are arriving.
    if (typeof rowCount === "number") {
      return Math.min(Math.max(rowCount, 0), loadedRowCount);
    }
    return loadedRowCount;
  }

  if (loadedRowCount <= 0) {
    // Placeholders while the page loads; a settled page with no rows is empty.
    return rowsSettled ? 0 : basePageTotal;
  }

  return Math.min(basePageTotal, loadedRowCount);
}
