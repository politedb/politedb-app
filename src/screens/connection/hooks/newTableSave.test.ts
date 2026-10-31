import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { useConnectionWindows } from "./useConnectionWindows";
import { getNewTableDraftEntries } from "./useConnectionActions";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";
import type { OpenWindow } from "src/types";

const TAB = "tab-1";
const DRAFT_ID = "table:public.untitled_table_1";

const draft = (tableName: string) => ({
  tableName,
  primaryKey: "id",
  columns: [{ column_name: "id", data_type: "integer", is_nullable: "NO" }],
});

beforeEach(() => {
  useScreenStore.setState({
    activeProfileScreen: TAB,
    profileTabs: [
      { id: TAB, profileId: "p1", engine: "postgres", label: "t" },
    ] as never,
    openWindows: { [TAB]: [] },
    activeWindowId: { [TAB]: null },
  });
  useConnectionStore.setState({ newTableData: {} } as never);
});

describe("opening the table a draft just created", () => {
  it("opens the created table even when its name is the closed draft's", async () => {
    useScreenStore.setState({
      openWindows: {
        [TAB]: [
          {
            id: DRAFT_ID,
            type: "table",
            table: { schema: "public", name: "untitled_table_1", new: true },
          } as OpenWindow,
        ],
      },
      activeWindowId: { [TAB]: DRAFT_ID },
    });
    const { result } = renderHook(() => useConnectionWindows(TAB));
    // Captured before the draft's window closes, as the create flow does.
    const openTable = result.current.openTable;
    act(() => useScreenStore.getState().removeWindows(TAB, [DRAFT_ID]));

    await act(async () => {
      await openTable({ schema: "public", name: "untitled_table_1" });
    });

    const s = useScreenStore.getState();
    const windows = s.openWindows[TAB] ?? [];
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      type: "table",
      table: { schema: "public", name: "untitled_table_1" },
    });
    expect((windows[0] as { table: { new?: boolean } }).table.new).toBeFalsy();
    expect(s.activeWindowId[TAB]).toBe(windows[0]!.id);
  });
});

describe("saving new-table drafts", () => {
  it("includes a draft whose window was closed, with its schema", () => {
    useConnectionStore
      .getState()
      .setNewTableData(TAB, DRAFT_ID, draft("orders") as never);
    const entries = getNewTableDraftEntries({
      tabId: TAB,
      openWindows: useScreenStore.getState().openWindows,
      engine: "postgres",
    });
    expect(entries.error).toBeNull();
    expect(entries.data).toHaveLength(1);
    expect(entries.data[0]!.window.id).toBe(DRAFT_ID);
    expect(entries.data[0]!.sql).toMatch(/CREATE TABLE "public"\."orders"/);
  });
});
