import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: m.invoke }));
vi.mock("src/stores/persistentStore", () => ({
  usePersistentStore: { getState: () => ({ scheduleSave: () => {} }) },
}));

import {
  assertTabTarget,
  checkRuntimeDispatch,
  checkTabTarget,
  TabTargetError,
} from "./assertTabTarget";
// Registers the dispatch guard, as the app does.
import "src/lib/runtimeConnection";
import { runQuery } from "src/lib/tauri/operation";
import { connectionRemove } from "src/lib/tauri/connection";
import { signalHealthInspectorBackend } from "src/lib/tauri/health-inspector-actions";
import { useConnectionStore } from "src/stores/connection";
import { useRuntimeTargetsStore } from "src/stores/runtimeTargets";
import { useScreenStore } from "src/stores/screen";
import { resetTabRuntimes, seedTabRuntime } from "src/test/fixtures/tabRuntime";

beforeEach(() => {
  vi.clearAllMocks();
  m.invoke.mockResolvedValue("op1");
  resetTabRuntimes();
  useConnectionStore.setState({ tableDataMap: {} } as never);
  seedTabRuntime({
    tabId: "a",
    runtimeId: "ra",
    target: { kind: "override", database: "b" },
  });
});

const codeOf = (tabId: string, runtimeId: string | undefined) =>
  checkTabTarget(tabId, runtimeId)?.code ?? null;

describe("checkTabTarget (D3)", () => {
  it("allows the tab's own connection on its target", () => {
    expect(codeOf("a", "ra")).toBeNull();
    expect(() => assertTabTarget("a", "ra")).not.toThrow();
  });

  it("refuses a closed tab and a missing connection", () => {
    expect(codeOf("gone", "ra")).toBe("TAB_CLOSED");
    expect(codeOf("a", undefined)).toBe("RUNTIME_NOT_AUTHORITATIVE");
  });

  it("refuses a tab whose target is unknown", () => {
    useScreenStore.getState().updateTab("a", { target: { kind: "unknown" } });
    expect(codeOf("a", "ra")).toBe("TAB_TARGET_UNKNOWN");
  });

  it("fails closed on a connection with no recorded identity", () => {
    useRuntimeTargetsStore.getState().register("ra", null, "a");
    expect(codeOf("a", "ra")).toBe("RUNTIME_IDENTITY_MISSING");
    useRuntimeTargetsStore.getState().forget("ra");
    expect(codeOf("a", "ra")).toBe("RUNTIME_IDENTITY_MISSING");
  });

  it("refuses a connection the backend refused as stale", () => {
    useRuntimeTargetsStore.getState().markRefused("ra", "RUNTIME_STALE");
    expect(codeOf("a", "ra")).toBe("RUNTIME_STALE");
  });

  it("refuses another tab's connection, even on the same target", () => {
    seedTabRuntime({
      tabId: "b",
      runtimeId: "rb",
      target: { kind: "override", database: "b" },
    });
    expect(codeOf("a", "rb")).toBe("RUNTIME_NOT_AUTHORITATIVE");
    expect(codeOf("b", "ra")).toBe("RUNTIME_NOT_AUTHORITATIVE");
  });

  it("never hands a connection to another tab once it has an owner", () => {
    seedTabRuntime({ tabId: "b", runtimeId: "rb" });
    useRuntimeTargetsStore.getState().setOwner("ra", "b");
    useRuntimeTargetsStore.getState().register("ra", null, "b");
    expect(useRuntimeTargetsStore.getState().owners.ra).toBe("a");
    useScreenStore.getState().updateTab("b", { runtimeConnectionId: "ra" });
    expect(codeOf("b", "ra")).not.toBeNull();
  });

  it("refuses a superseded connection of the same tab and target", () => {
    seedTabRuntime({
      tabId: "a",
      runtimeId: "ra2",
      target: { kind: "override", database: "b" },
    });
    // ra is still recorded as the tab's, on the same target, but replaced.
    useRuntimeTargetsStore.getState().setOwner("ra", "a");
    expect(codeOf("a", "ra")).toBe("RUNTIME_NOT_AUTHORITATIVE");
    expect(codeOf("a", "ra2")).toBeNull();
  });

  it("refuses a connection opened on another database, naming both", () => {
    useScreenStore.getState().updateTab("a", { target: { kind: "default" } });
    const refusal = checkTabTarget("a", "ra");
    expect(refusal?.code).toBe("RUNTIME_TARGET_MISMATCH");
    expect(refusal?.message).toBe(
      "This tab shows app but is connected to b. Reconnect the tab."
    );
    expect(() => assertTabTarget("a", "ra")).toThrow(TabTargetError);
  });

  it("uses a table's connection only when the tab acquired it on its target", () => {
    useScreenStore
      .getState()
      .updateTab("a", { runtimeConnectionId: undefined });
    useConnectionStore.setState({
      tableDataMap: { "a.public.t": { connectionId: "ra" } },
    } as never);
    expect(codeOf("a", "ra")).toBeNull();
    seedTabRuntime({ tabId: "b", runtimeId: "rb" });
    useConnectionStore.setState({
      tableDataMap: { "a.public.t": { connectionId: "rb" } },
    } as never);
    expect(codeOf("a", "rb")).toBe("RUNTIME_NOT_AUTHORITATIVE");
  });
});

describe("the dispatch guard", () => {
  it("refuses a connection no tab owns, except to remove it", () => {
    expect(checkRuntimeDispatch("operation_execute", "orphan")?.code).toBe(
      "RUNTIME_IDENTITY_MISSING"
    );
    expect(checkRuntimeDispatch("connection_remove", "orphan")).toBeNull();
  });

  it("checks the owning tab right before a command is sent", async () => {
    await expect(runQuery("ra", "select 1")).resolves.toBe("op1");
    expect(m.invoke).toHaveBeenCalledTimes(1);

    // The tab reconnected: the old connection takes no more work.
    seedTabRuntime({
      tabId: "a",
      runtimeId: "ra2",
      target: { kind: "override", database: "b" },
    });
    useRuntimeTargetsStore.getState().setOwner("ra", "a");
    m.invoke.mockClear();
    await expect(runQuery("ra", "delete from t")).rejects.toBeInstanceOf(
      TabTargetError
    );
    expect(m.invoke).not.toHaveBeenCalled();

    // Removing it is still allowed.
    await connectionRemove("ra");
    expect(m.invoke).toHaveBeenCalledWith("connection_remove", {
      connectionId: "ra",
    });
  });

  it("refuses work on a tab whose target became unknown", async () => {
    useScreenStore.getState().updateTab("a", { target: { kind: "unknown" } });
    await expect(runQuery("ra", "select 1")).rejects.toThrow(
      "could not be determined"
    );
    expect(m.invoke).not.toHaveBeenCalled();
  });

  it("guards health inspector signals, sent with runtimeConnectionId", async () => {
    const signal = (runtimeConnectionId: string) =>
      signalHealthInspectorBackend({
        runtimeConnectionId,
        pid: 42,
        backendToken: "t",
        kind: "terminate",
      });
    m.invoke.mockResolvedValue({ outcome: "signalled" });
    await expect(signal("ra")).resolves.toBe("signalled");
    expect(m.invoke).toHaveBeenCalledTimes(1);

    m.invoke.mockClear();
    useScreenStore.getState().updateTab("a", { target: { kind: "unknown" } });
    await expect(signal("ra")).resolves.toBe("refused");
    await expect(signal("orphan")).resolves.toBe("refused");
    expect(m.invoke).not.toHaveBeenCalled();
  });
});
