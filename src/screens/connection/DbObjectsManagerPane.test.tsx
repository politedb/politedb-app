import { render, screen } from "@testing-library/preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetadataApi } from "src/hooks/useDatabaseMetadata";
import type { DatabaseObjectItem } from "src/types";
import type { ConnectionRuntime } from "./ConnectionRuntimeContext";
import { ConnectionRuntimeProvider } from "./ConnectionRuntimeContext";
import { DbObjectsManagerPane } from "./DbObjectsManagerPane";

vi.mock("src/components/common/RetryableLazy", () => ({
  createRetryableLazy: () => () => <div data-testid="sql-editor" />,
}));

vi.mock("./hooks/useLoadDbObjectDefinition", () => ({
  useLoadDbObjectDefinition: () => ({
    sql: "CREATE FUNCTION new_function() RETURNS void AS $$ BEGIN END; $$ LANGUAGE plpgsql;",
    setSql: vi.fn(),
    baselineSql: "",
    setBaselineSql: vi.fn(),
    loading: false,
    loadError: null,
  }),
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
    vi.stubGlobal("IntersectionObserver", IntersectionObserverMock);
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("opens create mode without Save/Refresh toolbar and registers object save", () => {
    const get = vi.fn((_args: Parameters<MetadataApi["get"]>[0]) => ({
      schemas: ["public"],
      objects: functionItems(500),
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
    const objectSaveRef: ConnectionRuntime["objectSaveRef"] = { current: null };
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
      objectSaveRef,
      pendingTableAction: null,
      setPendingTableAction: vi.fn(),
    } as unknown as ConnectionRuntime;

    render(
      <ConnectionRuntimeProvider value={runtime}>
        <DbObjectsManagerPane
          win={{ id: "objects-1", type: "db-object-manager" }}
        />
      </ConnectionRuntimeProvider>
    );

    expect(screen.getByText("New function")).toBeTruthy();
    expect(screen.getByText("Regenerate")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh" })).toBeNull();
    expect(objectSaveRef.current).not.toBeNull();
    expect(objectSaveRef.current?.getPendingSql().length).toBeGreaterThan(0);
    expect(get.mock.calls[0]?.[0]).not.toHaveProperty("includeColumns");
  });
});
