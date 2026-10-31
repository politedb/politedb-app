import { act, render, screen, waitFor } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildDatabaseObjectItem } from "src/lib/databaseObjects";
import { editDraftKey } from "src/lib/objectDraftKey";
import { canExecute, useObjectDraftStore } from "src/stores/objectDrafts";
import { useScreenStore } from "src/stores/screen";
import { useLoadDbObjectDefinition } from "./useLoadDbObjectDefinition";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";

const loadMock = vi.fn();

vi.mock("src/lib/databaseObjects", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("src/lib/databaseObjects")>();
  return {
    ...actual,
    loadDatabaseObjectDefinition: (...args: unknown[]) => loadMock(...args),
  };
});

const TAB = "tab-1";

function item(name = "demo_fn") {
  return buildDatabaseObjectItem({
    engine: "postgres",
    kind: "function",
    schema: "public",
    name,
    signature: "id integer",
  });
}

function draftOf(object: ReturnType<typeof item>) {
  return useObjectDraftStore.getState().drafts[TAB]?.[editDraftKey(object.id)];
}

function Harness(props: {
  object: ReturnType<typeof item> | null;
  connectionId?: string;
}) {
  const key = props.object ? editDraftKey(props.object.id) : "new:function:x";
  const generation = useObjectDraftStore(
    (s) => s.drafts[TAB]?.[key]?.generation
  );
  const sql = useObjectDraftStore((s) => s.drafts[TAB]?.[key]?.sql ?? "");
  const result = useLoadDbObjectDefinition({
    tabId: TAB,
    draftKey: key,
    item: props.object,
    engine: "postgres",
    connectionId: props.connectionId ?? "conn-1",
    draftGeneration: generation,
  });

  return (
    <div>
      <div data-testid="loading">{String(result.loading)}</div>
      <div data-testid="sql">{sql}</div>
      <div data-testid="error">{result.loadError ?? ""}</div>
    </div>
  );
}

function setLiveTab(connectionId: string, epoch = 0) {
  useScreenStore.setState({
    profileTabs: [{ id: TAB, runtimeConnectionId: connectionId } as never],
    tabEpoch: { [TAB]: epoch },
  });
  seedTabRuntime({ tabId: TAB, runtimeId: connectionId });
}

function ensureDraft(object: ReturnType<typeof item>) {
  useObjectDraftStore
    .getState()
    .ensureEditDraft(TAB, editDraftKey(object.id), object);
}

describe("useLoadDbObjectDefinition", () => {
  beforeEach(() => {
    resetTabRuntimes();
    setLiveTab("conn-1");
    loadMock.mockReset();
    useObjectDraftStore.getState().clearAll();
  });

  it("reads nothing through another tab's connection and keeps the draft (D3)", async () => {
    seedTabRuntime({ tabId: "other", runtimeId: "conn-other" });
    const first = item();
    ensureDraft(first);
    render(<Harness object={first} connectionId="conn-other" />);
    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toMatch(
        /no longer uses this connection/
      )
    );
    expect(loadMock).not.toHaveBeenCalled();
    expect(draftOf(first)?.loaded).not.toBe(true);
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("loads a definition into the draft once across re-renders", async () => {
    loadMock.mockResolvedValue({ sql: "CREATE FUNCTION demo_fn()" });
    const first = item();
    ensureDraft(first);

    const { rerender } = render(<Harness object={first} />);

    await waitFor(() =>
      expect(screen.getByTestId("sql").textContent).toBe(
        "CREATE FUNCTION demo_fn()"
      )
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(draftOf(first)?.loaded).toBe(true);
    expect(draftOf(first)?.baselineSql).toBe("CREATE FUNCTION demo_fn()");

    rerender(<Harness object={{ ...first }} />);
    rerender(<Harness object={{ ...first }} />);
    expect(loadMock).toHaveBeenCalledTimes(1);
  });

  it("does not start a second fetch while the same object is loading", async () => {
    let resolveLoad: ((value: { sql: string }) => void) | undefined;
    loadMock.mockImplementation(
      () =>
        new Promise<{ sql: string }>((resolve) => {
          resolveLoad = resolve;
        })
    );
    const first = item();
    ensureDraft(first);

    const { rerender } = render(<Harness object={first} />);
    await waitFor(() =>
      expect(screen.getByTestId("loading").textContent).toBe("true")
    );
    rerender(<Harness object={{ ...first }} />);
    expect(loadMock).toHaveBeenCalledTimes(1);

    resolveLoad?.({ sql: "CREATE FUNCTION demo_fn()" });
    await waitFor(() =>
      expect(screen.getByTestId("loading").textContent).toBe("false")
    );
    expect(screen.getByTestId("sql").textContent).toBe(
      "CREATE FUNCTION demo_fn()"
    );
  });

  it("ignores a response for an object no longer shown", async () => {
    const resolvers: Array<(value: { sql: string }) => void> = [];
    loadMock.mockImplementation(
      () =>
        new Promise<{ sql: string }>((resolve) => {
          resolvers.push(resolve);
        })
    );
    const first = item("alpha");
    const second = item("beta");
    ensureDraft(first);
    ensureDraft(second);

    const { rerender } = render(<Harness object={first} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));
    rerender(<Harness object={second} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolvers[0]?.({ sql: "CREATE FUNCTION alpha()" });
      resolvers[1]?.({ sql: "CREATE FUNCTION beta()" });
    });

    await waitFor(() =>
      expect(screen.getByTestId("sql").textContent).toBe(
        "CREATE FUNCTION beta()"
      )
    );
    expect(draftOf(first)?.loaded).toBe(false);
    expect(draftOf(first)?.sql).toBe("");
  });

  it("never overwrites unsaved work; flags a changed definition", async () => {
    loadMock.mockResolvedValue({ sql: "CREATE FUNCTION v1()" });
    const first = item();
    ensureDraft(first);
    const { unmount } = render(<Harness object={first} />);
    await waitFor(() => expect(draftOf(first)?.loaded).toBe(true));
    unmount();

    useObjectDraftStore
      .getState()
      .setSql(TAB, editDraftKey(first.id), "CREATE FUNCTION mine()");
    loadMock.mockResolvedValue({ sql: "CREATE FUNCTION v2()" });
    setLiveTab("conn-2", 1);
    render(<Harness object={first} connectionId="conn-2" />);

    await waitFor(() => expect(draftOf(first)?.conflict).toBe(true));
    expect(draftOf(first)?.sql).toBe("CREATE FUNCTION mine()");
    expect(draftOf(first)?.baselineSql).toBe("CREATE FUNCTION v1()");
  });

  it("drops a definition overtaken by an edit and a save", async () => {
    loadMock.mockResolvedValueOnce({ sql: "v1" });
    const first = item();
    ensureDraft(first);
    const view = render(<Harness object={first} />);
    await waitFor(() => expect(draftOf(first)?.loaded).toBe(true));
    view.unmount();

    // Reopen: a slow fetch of the old definition is pending.
    let resolveOld!: (value: { sql: string }) => void;
    loadMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveOld = resolve))
    );
    render(<Harness object={first} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(2));

    const key = editDraftKey(first.id);
    const store = useObjectDraftStore.getState();
    act(() => store.setSql(TAB, key, "v2"));
    const generation = draftOf(first)!.generation;
    act(() => store.markSaved(TAB, key, generation, "v2"));

    await act(async () => resolveOld({ sql: "v1" }));
    expect(draftOf(first)?.sql).toBe("v2");
    expect(draftOf(first)?.baselineSql).toBe("v2");
    expect(draftOf(first)?.conflict).toBe(false);
  });

  it("ignores a response that lands after unmount", async () => {
    loadMock.mockResolvedValueOnce({ sql: "v1" });
    const first = item();
    ensureDraft(first);
    const view = render(<Harness object={first} />);
    await waitFor(() => expect(draftOf(first)?.loaded).toBe(true));
    view.unmount();

    let resolveLate!: (value: { sql: string }) => void;
    loadMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLate = resolve))
    );
    const again = render(<Harness object={first} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(2));
    again.unmount();
    await act(async () => resolveLate({ sql: "changed elsewhere" }));
    expect(draftOf(first)?.sql).toBe("v1");
  });

  it("reloads after a discard (new draft generation)", async () => {
    loadMock.mockResolvedValue({ sql: "CREATE FUNCTION v1()" });
    const first = item();
    ensureDraft(first);
    render(<Harness object={first} />);
    await waitFor(() => expect(draftOf(first)?.loaded).toBe(true));

    act(() => {
      useObjectDraftStore.getState().revert(TAB, editDraftKey(first.id));
    });
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(2));
  });

  it("does not fetch without an object", () => {
    render(<Harness object={null} />);
    expect(loadMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("loading").textContent).toBe("false");
  });

  it("keeps the draft as it is when the load fails", async () => {
    loadMock.mockRejectedValue(
      new Error("Object definition could not be loaded.")
    );
    const first = item();
    ensureDraft(first);

    render(<Harness object={first} />);

    await waitFor(() =>
      expect(screen.getByTestId("error").textContent).toBe(
        "Object definition could not be loaded."
      )
    );
    expect(screen.getByTestId("loading").textContent).toBe("false");
    expect(draftOf(first)?.loaded).toBe(false);
    expect(draftOf(first)?.sql).toBe("");
  });

  it("never clears a missing verdict from a later metadata refresh", async () => {
    loadMock.mockResolvedValueOnce({ sql: "v1" });
    const first = item();
    const key = editDraftKey(first.id);
    ensureDraft(first);
    const view = render(<Harness object={first} />);
    await waitFor(() => expect(draftOf(first)?.loaded).toBe(true));
    view.unmount();
    useObjectDraftStore.getState().setSql(TAB, key, "mine");

    let resolveLate!: (value: { sql: string }) => void;
    loadMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLate = resolve))
    );
    render(<Harness object={first} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(2));

    // A complete metadata refresh finds the object dropped first...
    act(() => useObjectDraftStore.getState().syncMissing(TAB, new Set()));
    expect(draftOf(first)?.missing).toBe(true);
    // ...then the older definition arrives (and differs from the baseline).
    await act(async () => resolveLate({ sql: "changed" }));

    expect(draftOf(first)?.missing).toBe(true);
    expect(canExecute(draftOf(first)!)).toBe(false);
    expect(draftOf(first)?.sql).toBe("mine");
    expect(draftOf(first)?.baselineSql).toBe("v1");
  });

  it("drops a response after the tab reconnected away and back", async () => {
    let resolveLate!: (value: { sql: string }) => void;
    loadMock.mockImplementationOnce(
      () => new Promise((resolve) => (resolveLate = resolve))
    );
    const first = item();
    ensureDraft(first);
    render(<Harness object={first} />);
    await waitFor(() => expect(loadMock).toHaveBeenCalledTimes(1));

    // No re-render in between: only the live screen store knows.
    setLiveTab("conn-1", 2);
    await act(async () => resolveLate({ sql: "from the old connection" }));
    expect(draftOf(first)?.loaded).toBe(false);
    expect(draftOf(first)?.sql).toBe("");
  });
});
