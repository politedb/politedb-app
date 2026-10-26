import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionStore } from "src/stores/connection";
import { useScreenStore } from "src/stores/screen";
import {
  forgetImportedTableRows,
  importNeedsTableTab,
} from "./standaloneImport";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

const users = { schema: "public", name: "users" };

beforeEach(() => {
  vi.restoreAllMocks();
  useScreenStore.setState({ openWindows: { t1: [] } });
  useConnectionStore.setState({ dataPatchMap: {} } as never);
});

describe("importNeedsTableTab", () => {
  it("imports without the tab when it is closed and clean", () => {
    expect(importNeedsTableTab("t1", users)).toBe(false);
  });

  it("uses the tab when it is open", () => {
    useScreenStore.setState({
      openWindows: {
        t1: [{ id: "w1", type: "table", table: users } as never],
      },
    });
    expect(importNeedsTableTab("t1", users)).toBe(true);
    expect(importNeedsTableTab("t1", { schema: "public", name: "x" })).toBe(
      false
    );
  });

  it("uses the tab when a closed tab left unsaved row changes", () => {
    useConnectionStore.setState({
      dataPatchMap: {
        t1: {
          w1: {
            tableWindow: { id: "w1", type: "table", table: users },
            patches: { update: { data: { "0": { name: "x" } } } },
          },
        },
      },
    } as never);
    expect(importNeedsTableTab("t1", users)).toBe(true);
  });
});

describe("forgetImportedTableRows", () => {
  it("drops the cached rows of a closed, clean table in its own tab only", () => {
    const store = useConnectionStore.getState();
    const clearRows = vi.spyOn(store, "clearRows");
    const removeTableDataMap = vi.spyOn(store, "removeTableDataMap");
    forgetImportedTableRows("t1", users);
    expect(clearRows).toHaveBeenCalledWith("t1.public.users");
    expect(removeTableDataMap).toHaveBeenCalledWith("t1.public.users");
  });

  it("leaves an open or edited table untouched", () => {
    useScreenStore.setState({
      openWindows: {
        t1: [{ id: "w1", type: "table", table: users } as never],
      },
    });
    const store = useConnectionStore.getState();
    const clearRows = vi.spyOn(store, "clearRows");
    clearRows.mockClear();
    forgetImportedTableRows("t1", users);
    expect(clearRows).not.toHaveBeenCalled();
  });
});
