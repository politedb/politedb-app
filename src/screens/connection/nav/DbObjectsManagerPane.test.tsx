import { render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import type { DatabaseObjectItem } from "src/types";
import type { ConnectionRuntime } from "../workspace/ConnectionRuntimeContext";
import { ConnectionRuntimeProvider } from "../workspace/ConnectionRuntimeContext";
import { DbObjectsManagerPane } from "./DbObjectsManagerPane";
import { useObjectDraftStore } from "src/stores/objectDrafts";
import { collectPendingObjectSql } from "src/lib/objectEditorDraftCache";

// The editor stand-in keeps its latest props, so tests can fire editor
// changes through the pane's real callback without a re-render.
const editor = vi.hoisted(() => ({
  props: null as null | {
    onCommitContent?: (id: string, next: string) => void;
    persistDraft?: boolean;
    storageId?: string;
  },
}));
vi.mock("src/components/common/RetryableLazy", () => ({
  createRetryableLazy: () => (props: NonNullable<typeof editor.props>) => {
    editor.props = props;
    return <div data-testid="sql-editor" />;
  },
}));

vi.mock("../hooks/useLoadDbObjectDefinition", () => ({
  useLoadDbObjectDefinition: () => ({ loading: false, loadError: null }),
}));

class IntersectionObserverMock {
  observe() {}
  disconnect() {}
}

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function functionItems(count: number): DatabaseObjectItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `function:public:function_${index}::`,
    kind: "function",
    schema: "public",
    name: `function_${index}`,
    signature: "",
    engine: "postgres",
    capability: {
      canList: true,
      canReadDefinition: true,
      canCreate: true,
      canEdit: true,
      canDelete: true,
    },
  }));
}

describe("DbObjectsManagerPane", () => {
  beforeEach(() => {
    useObjectDraftStore.getState().clearAll();
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  function runtimeWith(objects: DatabaseObjectItem[]) {
    const get = vi.fn((_args: Parameters<MetadataApi["get"]>[0]) => ({
      schemas: ["public"],
      objects,
      tables: [],
      columnsByTable: {},
      columnDetailsByTable: {},
      columnsLoaded: false,
      version: "",
      loading: false,
      loaded: true,
      error: null,
      progress: 100,
      stage: "done" as const,
      engine: "postgres" as const,
    }));
    const metadata = { get } as unknown as MetadataApi;
    const runtime = {
      profileId: "profile-1",
      engine: "postgres",
      sqlScopeKey: "scope-1",
      metaKey: "postgres:profile-1",
      metadata,
      activeSchema: "public",
      runtimeConnectionId: "connection-1",
      isProfileLocked: false,
      sqlSafetyMode: "default",
      limit: 300,
      offset: 0,
      loadError: null,
      runSqlWithHistory: vi.fn(),
      refreshSchemaAndTables: vi.fn(),
      newTableSaveRef: { current: null },
      pendingTableAction: null,
      setPendingTableAction: vi.fn(),
    } as unknown as ConnectionRuntime;
    return { runtime, get };
  }

  it("seeds a create draft in the store, kept after the window closes", () => {
    const { runtime, get } = runtimeWith(functionItems(500));
    const { unmount } = render(
      <ConnectionRuntimeProvider value={runtime}>
        <DbObjectsManagerPane
          win={{
            id: "db-object-manager:new:function:abc",
            type: "db-object-manager",
            initialKind: "function",
            initialObjectId: "",
          }}
        />
      </ConnectionRuntimeProvider>
    );

    expect(screen.getByText("New function")).toBeTruthy();
    expect(screen.getByText("Regenerate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    const draft =
      useObjectDraftStore.getState().drafts["profile-1"]?.["new:function:abc"];
    expect(draft?.mode).toBe("create");
    expect(draft?.form.name).toBe("new_function");
    expect(
      collectPendingObjectSql({ tabId: "profile-1", engine: "postgres" }).length
    ).toBeGreaterThan(0);
    expect(get.mock.calls[0]?.[0]).not.toHaveProperty("includeColumns");

    unmount();
    expect(
      useObjectDraftStore.getState().drafts["profile-1"]?.["new:function:abc"]
    ).toBeTruthy();
  });

  it("starts a clean edit draft for an existing object", () => {
    const items = functionItems(3);
    const { runtime } = runtimeWith(items);
    render(
      <ConnectionRuntimeProvider value={runtime}>
        <DbObjectsManagerPane
          win={{
            id: `db-object-manager:obj:${items[1]!.id}`,
            type: "db-object-manager",
            initialKind: "function",
            initialObjectId: items[1]!.id,
          }}
        />
      </ConnectionRuntimeProvider>
    );

    const draft =
      useObjectDraftStore.getState().drafts["profile-1"]?.[
        `obj:${items[1]!.id}`
      ];
    expect(draft?.mode).toBe("edit");
    expect(draft?.item?.name).toBe("function_1");
    expect(
      collectPendingObjectSql({ tabId: "profile-1", engine: "postgres" })
    ).toEqual([]);
  });

  it("stores every editor change, including a return to the rendered text", () => {
    const items = functionItems(1);
    const key = `obj:${items[0]!.id}`;
    const store = useObjectDraftStore.getState();
    store.ensureEditDraft("profile-1", key, items[0]!);
    store.applyDefinition(
      "profile-1",
      key,
      useObjectDraftStore.getState().drafts["profile-1"]![key]!.generation,
      "v1",
      items[0]!
    );
    const { runtime } = runtimeWith(items);
    render(
      <ConnectionRuntimeProvider value={runtime}>
        <DbObjectsManagerPane
          win={{
            id: `db-object-manager:${key}`,
            type: "db-object-manager",
            initialKind: "function",
            initialObjectId: items[0]!.id,
          }}
        />
      </ConnectionRuntimeProvider>
    );
    expect(editor.props?.persistDraft).toBe(false);
    expect(editor.props?.storageId).toBe(`db-object:profile-1:${key}`);

    // Edit, then undo back to the rendered text, before any re-render.
    const commit = editor.props!.onCommitContent!;
    commit("w", "v2");
    commit("w", "v1");
    const draft = useObjectDraftStore.getState().drafts["profile-1"]![key]!;
    expect(draft.sql).toBe("v1");
    expect(
      collectPendingObjectSql({ tabId: "profile-1", engine: "postgres" })
    ).toEqual([]);
  });

  it("does the same for a new object", () => {
    const { runtime } = runtimeWith([]);
    render(
      <ConnectionRuntimeProvider value={runtime}>
        <DbObjectsManagerPane
          win={{
            id: "db-object-manager:new:function:abc",
            type: "db-object-manager",
            initialKind: "function",
            initialObjectId: "",
          }}
        />
      </ConnectionRuntimeProvider>
    );
    const rendered =
      useObjectDraftStore.getState().drafts["profile-1"]!["new:function:abc"]!
        .sql;
    const commit = editor.props!.onCommitContent!;
    commit("w", "CREATE FUNCTION other()");
    commit("w", rendered);
    expect(
      useObjectDraftStore.getState().drafts["profile-1"]!["new:function:abc"]!
        .sql
    ).toBe(rendered);
  });
});
