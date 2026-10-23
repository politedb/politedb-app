import { describe, expect, it } from "vitest";
import { pageRowCount } from "./pageRowCount";

const base = {
  hasRowsWindow: true,
  hasAppliedFilters: false,
  rowCount: 1000,
  loadedRowCount: 0,
  basePageTotal: 100,
  rowsSettled: false,
};

describe("pageRowCount", () => {
  it("keeps placeholders while a page loads", () => {
    expect(pageRowCount(base)).toBe(100);
  });

  it("shows no rows for a settled empty page past an estimate", () => {
    // Estimate 1000, the real table has 1100 rows: page 1100 is empty.
    expect(pageRowCount({ ...base, rowsSettled: true })).toBe(0);
  });

  it("shows no rows for an empty table estimated at zero", () => {
    expect(pageRowCount({ ...base, rowCount: 0, rowsSettled: true })).toBe(0);
  });

  it("shows the loaded rows of full and partial pages", () => {
    expect(
      pageRowCount({ ...base, loadedRowCount: 100, rowsSettled: true })
    ).toBe(100);
    expect(
      pageRowCount({ ...base, loadedRowCount: 41, rowsSettled: true })
    ).toBe(41);
  });

  it("uses the filtered count with filters", () => {
    expect(
      pageRowCount({
        ...base,
        hasAppliedFilters: true,
        rowCount: 7,
        loadedRowCount: 100,
      })
    ).toBe(7);
  });
});
