import { describe, expect, it } from "vitest";
import type { TableWindow } from "src/types";
import { tablesToReloadOnManualRefresh } from "./refreshTableTarget";

function tableWindow(
  id: string,
  schema: string,
  name: string,
  isNew = false
): TableWindow {
  return {
    id,
    type: "table",
    table: { schema, name, ...(isNew ? { new: true } : {}) },
  } as TableWindow;
}

describe("tablesToReloadOnManualRefresh", () => {
  it("reloads only the focused table pane", () => {
    const focused = tableWindow("w-users", "public", "users");
    expect(tablesToReloadOnManualRefresh(focused)).toEqual([focused]);
  });

  it("reloads nothing when focus is not a table pane", () => {
    expect(tablesToReloadOnManualRefresh(undefined)).toEqual([]);
  });

  it("skips unsaved new-table drafts", () => {
    expect(
      tablesToReloadOnManualRefresh(tableWindow("w-new", "public", "t", true))
    ).toEqual([]);
  });
});
