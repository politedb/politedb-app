import { act, renderHook } from "@testing-library/preact";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ run: vi.fn(), version: vi.fn() }));

vi.mock("src/lib/tauri/query", () => ({ runSqlQuery: m.run }));
vi.mock("src/lib/tauri", () => ({ connectionVersion: m.version }));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import { useScreenStore } from "src/stores/screen";
import { useConnectionHealthCheck } from "./useConnectionHealthCheck";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";

beforeEach(() => {
  useScreenStore.setState({
    profileTabs: [
      {
        id: "t",
        profileId: "p",
        engine: "postgres",
        runtimeConnectionId: "rt",
      },
    ] as never,
    tabEpoch: {},
  });
  resetTabRuntimes();
  seedTabRuntime({ tabId: "t", runtimeId: "rt", profileId: "p" });
  useScreenStore.setState({ tabEpoch: {} });
  m.run.mockReset();
});

describe("a ping that lost authority (R5)", () => {
  it("stops pending at once and never reports health", async () => {
    let answer!: () => void;
    m.run.mockReturnValue(new Promise<void>((r) => (answer = () => r())));
    const { result } = renderHook(() =>
      useConnectionHealthCheck({
        runtimeConnectionId: "rt",
        tabId: "t",
        engine: "postgres",
      })
    );
    expect(result.current.checking).toBe(true);
    // The profile was saved again: the tab's epoch moves.
    act(() => useScreenStore.getState().bumpTabEpochs(["t"]));
    expect(result.current.checking).toBe(false);
    await act(async () => answer());
    expect(result.current.status).not.toBe("healthy");
    expect(result.current.latencyMs).toBeNull();
  });

  it("never pings, or reports healthy, another tab's connection (D3)", async () => {
    seedTabRuntime({ tabId: "other", runtimeId: "rt-other" });
    m.run.mockResolvedValue({});
    const { result } = renderHook(() =>
      useConnectionHealthCheck({
        runtimeConnectionId: "rt-other",
        tabId: "t",
        engine: "postgres",
      })
    );
    await act(async () => {});
    expect(m.run).not.toHaveBeenCalled();
    expect(result.current.status).toBe("down");
    expect(result.current.checking).toBe(false);
  });
});
