import { describe, expect, it, vi } from "vitest";

vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: vi.fn() }) },
}));

import { useConnectionLogStore } from "./connectionLog";
import type { ConnectionOpenLogEntry } from "src/types";

const entry = (id: string, status: ConnectionOpenLogEntry["status"]) =>
  ({
    id,
    tabId: `tab-${id}`,
    profileId: "p",
    profileLabel: "P",
    engine: "postgres",
    host: "h",
    deviceName: "d",
    openedAt: 1,
    status,
  }) as ConnectionOpenLogEntry;

describe("connection log clearLog", () => {
  it("clears finished sessions and keeps the open ones", () => {
    const store = useConnectionLogStore.getState();
    store.hydrate(
      [entry("a", "closed"), entry("b", "active"), entry("c", "failed")],
      { "tab-b": "b" }
    );

    useConnectionLogStore.getState().clearLog();

    const after = useConnectionLogStore.getState();
    expect(after.entries.map((e) => e.id)).toEqual(["b"]);
    expect(after.activeByTabId).toEqual({ "tab-b": "b" });

    // The kept session can still be ended when its tab closes.
    after.endSession("tab-b");
    expect(useConnectionLogStore.getState().entries[0]!.status).toBe("closed");
  });
});
