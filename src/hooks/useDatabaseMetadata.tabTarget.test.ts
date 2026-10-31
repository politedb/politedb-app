import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ runSqlQuery: vi.fn() }));
vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: m.runSqlQuery }));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { useDatabaseMetadata } from "./useDatabaseMetadata";
import { useScreenStore } from "src/stores/screen";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";

// The metadata key names its tab (`<engine>:<tab id>`).
const META_KEY = "postgres:tab-1";

beforeEach(() => {
  vi.clearAllMocks();
  m.runSqlQuery.mockResolvedValue({ rows: [] });
  resetTabRuntimes();
  seedTabRuntime({ tabId: "tab-1", runtimeId: "conn-1" });
  seedTabRuntime({ tabId: "tab-2", runtimeId: "conn-2" });
});

async function load(connectionId: string) {
  const { result } = renderHook(() => useDatabaseMetadata());
  let meta!: Awaited<ReturnType<typeof result.current.load>>;
  await act(async () => {
    meta = await result.current.load({
      metaKey: META_KEY,
      engine: "postgres",
      connectionId,
    });
  });
  return meta;
}

describe("metadata is read through its tab's own connection (D3)", () => {
  it("is not refused on the tab's own connection", async () => {
    const meta = await load("conn-1");
    expect(meta.error ?? "").not.toMatch(
      /no longer uses|could not be determined|Reconnect/
    );
    expect(m.runSqlQuery.mock.calls.every(([id]) => id === "conn-1")).toBe(
      true
    );
  });

  it("reads nothing through another tab's connection", async () => {
    const meta = await load("conn-2");
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(meta.error).toMatch(/no longer uses this connection/);
    expect(meta.loading).toBe(false);
  });

  it("reads nothing on a tab whose target is unknown", async () => {
    useScreenStore
      .getState()
      .updateTab("tab-1", { target: { kind: "unknown" } });
    const meta = await load("conn-1");
    expect(m.runSqlQuery).not.toHaveBeenCalled();
    expect(meta.error).toMatch(/could not be determined/);
  });
});
