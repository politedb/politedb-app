import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ showMessage: vi.fn(async () => {}) }));
vi.mock("src/lib/system-dialog", () => ({ showMessage: m.showMessage }));
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

const collect = () =>
  getNewTableDraftEntries({
    tabId: TAB,
    openWindows: useScreenStore.getState().openWindows,
    engine: "postgres",
  });

const setDraft = (windowId: string, data: object) =>
  useConnectionStore.getState().setNewTableData(TAB, windowId, data as never);

describe("saving new-table drafts", () => {
  it("saves a draft whose window was closed, in the schema it records", () => {
    setDraft(DRAFT_ID, {
      ...draft("orders"),
      schema: "public",
      windowName: "untitled_table_1",
    });
    const entries = collect();
    expect(entries.error).toBeNull();
    expect(entries.data).toHaveLength(1);
    expect(entries.data[0]!.window.id).toBe(DRAFT_ID);
    expect(entries.data[0]!.sql).toMatch(/CREATE TABLE "public"\."orders"/);
  });

  it.each([
    ["a dotted schema", "tenant.eu", "untitled"],
    ["a dotted table name", "public", "untitled.v2"],
    ["both dotted", "tenant.eu", "untitled.v2"],
  ])(
    "keeps the destination of %s once its window closes",
    (_, schema, name) => {
      const windowId = `table:${schema}.${name}`;
      const open = {
        id: windowId,
        type: "table",
        table: { schema, name, new: true },
      } as OpenWindow;
      setDraft(windowId, { ...draft("orders"), schema, windowName: name });

      useScreenStore.setState({ openWindows: { [TAB]: [open] } });
      const whileOpen = collect().data[0]!.sql;
      useScreenStore.setState({ openWindows: { [TAB]: [] } });
      const onceClosed = collect().data[0]!.sql;

      expect(onceClosed).toBe(whileOpen);
      expect(onceClosed).toContain(`"${schema}"."orders"`);
    }
  );

  it("never guesses the schema of an older draft with an ambiguous window id, and says so", () => {
    setDraft("table:tenant.eu.untitled", draft("orders"));
    expect(collect()).toEqual({
      data: [],
      error: null,
      unresolved: [{ windowId: "table:tenant.eu.untitled", name: "orders" }],
    });
  });

  it("still saves the other drafts next to an unresolved one", () => {
    setDraft("table:tenant.eu.untitled", draft("orders"));
    setDraft(DRAFT_ID, {
      ...draft("invoices"),
      schema: "public",
      windowName: "untitled_table_1",
    });
    const entries = collect();
    expect(entries.data.map((e) => e.window.id)).toEqual([DRAFT_ID]);
    expect(entries.unresolved.map((u) => u.name)).toEqual(["orders"]);
  });

  it("takes an older draft's schema from its open window", () => {
    const windowId = "table:tenant.eu.untitled";
    setDraft(windowId, draft("orders"));
    useScreenStore.setState({
      openWindows: {
        [TAB]: [
          {
            id: windowId,
            type: "table",
            table: { schema: "tenant.eu", name: "untitled", new: true },
          } as OpenWindow,
        ],
      },
    });
    const entries = collect();
    expect(entries.unresolved).toEqual([]);
    expect(entries.data[0]!.sql).toContain('"tenant.eu"."orders"');
  });

  it("still saves an older draft whose window id is unambiguous", () => {
    setDraft(DRAFT_ID, draft("orders"));
    expect(collect().data[0]!.sql).toMatch(/CREATE TABLE "public"\."orders"/);
  });

  it("runs neither of two drafts creating the same table, and says so", () => {
    setDraft(DRAFT_ID, {
      ...draft("orders"),
      schema: "public",
      windowName: "untitled_table_1",
    });
    setDraft("table:public.untitled_table_2", {
      ...draft("orders"),
      schema: "public",
      windowName: "untitled_table_2",
    });
    const entries = collect();
    expect(entries.data).toEqual([]);
    expect(entries.error).toMatch(/both named "orders"/);
  });
});

describe("reopening a closed draft from the sidebar", () => {
  it("does not open an older draft whose schema cannot be told, and says why", async () => {
    const windowId = "table:tenant.eu.untitled";
    setDraft(windowId, draft("orders"));
    const { result } = renderHook(() => useConnectionWindows(TAB));
    await act(async () => {
      await result.current.openTable({
        schema: "public",
        name: "orders",
        new: true,
        draftWindowId: windowId,
        unresolvedDraft: true,
      });
    });
    expect(useScreenStore.getState().openWindows[TAB]).toEqual([]);
    expect(m.showMessage).toHaveBeenCalledWith(
      expect.stringContaining("schema cannot be determined"),
      expect.objectContaining({ kind: "warning" })
    );
  });

  it("reopens its own window and draft, never a second draft", async () => {
    setDraft(DRAFT_ID, {
      ...draft("orders"),
      schema: "public",
      windowName: "untitled_table_1",
    });
    const { result } = renderHook(() => useConnectionWindows(TAB));
    // The sidebar lists it under the name being typed.
    await act(async () => {
      await result.current.openTable({
        schema: "public",
        name: "orders",
        new: true,
        draftWindowId: DRAFT_ID,
      });
    });
    const s = useScreenStore.getState();
    expect(s.openWindows[TAB]!.map((w) => w.id)).toEqual([DRAFT_ID]);
    expect(s.activeWindowId[TAB]).toBe(DRAFT_ID);
    expect(
      Object.keys(useConnectionStore.getState().newTableData[TAB] ?? {})
    ).toEqual([DRAFT_ID]);
    const entries = collect();
    expect(entries.data).toHaveLength(1);
    expect(entries.data[0]!.sql).toMatch(/"public"\."orders"/);
  });
});
