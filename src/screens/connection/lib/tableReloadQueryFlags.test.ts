import { describe, expect, it } from "vitest";
import { buildTableReloadQueryFlags } from "./tableReloadQueryFlags";

describe("buildTableReloadQueryFlags", () => {
  it("preserves applied filters and sort while reloading edits", () => {
    const filters = [
      {
        id: 1,
        column: "status",
        operator: "=",
        value: "active",
        enabled: true,
      },
    ];
    const sortBy = { colName: "created_at", direction: "desc" as const };

    expect(
      buildTableReloadQueryFlags(
        { force: true, refreshRows: true },
        {
          filterBarVisible: true,
          filters,
          filterCombine: "AND",
          appliedFilters: filters,
          appliedFilterCombine: "OR",
        },
        sortBy
      )
    ).toEqual({
      force: true,
      refreshRows: true,
      filters,
      filterCombine: "OR",
      sortBy,
    });
  });

  it("does not apply incomplete filters", () => {
    expect(
      buildTableReloadQueryFlags(
        {},
        {
          filterBarVisible: true,
          filters: [],
          filterCombine: "AND",
          appliedFilters: [
            {
              id: 1,
              column: "",
              operator: "=",
              value: "active",
              enabled: true,
            },
          ],
          appliedFilterCombine: "AND",
        },
        null
      )
    ).toEqual({ filters: undefined, filterCombine: "AND", sortBy: null });
  });
});
