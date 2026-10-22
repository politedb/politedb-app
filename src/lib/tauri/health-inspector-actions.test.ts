import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPostgresInstanceAppName,
  resetPostgresInstanceAppNameCache,
  signalHealthInspectorBackend,
} from "./health-inspector-actions";

const target = {
  runtimeConnectionId: "c1",
  pid: 4242,
  backendToken: "2026-10-22T03:04:05.123456Z",
  kind: "cancel" as const,
};

describe("signalHealthInspectorBackend", () => {
  it("sends the target and returns Rust's outcome", async () => {
    const invoke = vi.fn(async () => ({ outcome: "signalled" }));
    expect(await signalHealthInspectorBackend(target, invoke as any)).toBe(
      "signalled"
    );
    expect(invoke).toHaveBeenCalledWith("health_inspector_signal_backend", {
      runtimeConnectionId: "c1",
      pid: 4242,
      backendToken: "2026-10-22T03:04:05.123456Z",
      kind: "cancel",
    });
  });

  it("refuses invalid targets without calling Rust", async () => {
    const invoke = vi.fn();
    for (const bad of [
      { ...target, pid: 0 },
      { ...target, pid: 2_147_483_648 },
      { ...target, pid: 1.5 },
      { ...target, kind: "kill" as any },
    ]) {
      expect(await signalHealthInspectorBackend(bad, invoke as any)).toBe(
        "invalid"
      );
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it("treats anything uncertain after the call as unknown", async () => {
    expect(
      await signalHealthInspectorBackend(target, (async () => {
        throw new Error("ipc closed");
      }) as any)
    ).toBe("unknown");
    for (const payload of [null, {}, { outcome: "done" }, { outcome: 1 }]) {
      expect(
        await signalHealthInspectorBackend(target, (async () => payload) as any)
      ).toBe("unknown");
    }
  });
});

describe("getPostgresInstanceAppName", () => {
  beforeEach(() => resetPostgresInstanceAppNameCache());

  it("caches a valid name", async () => {
    const invoke = vi.fn(async () => "PoliteDB/abcd1234");
    expect(await getPostgresInstanceAppName(invoke as any)).toBe(
      "PoliteDB/abcd1234"
    );
    await getPostgresInstanceAppName(invoke as any);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("returns null for unexpected names and retries after failures", async () => {
    expect(
      await getPostgresInstanceAppName((async () => "PoliteDB") as any)
    ).toBeNull();
    resetPostgresInstanceAppNameCache();
    const failing = vi.fn(async () => {
      throw new Error("no");
    });
    expect(await getPostgresInstanceAppName(failing as any)).toBeNull();
    const ok = vi.fn(async () => "PoliteDB/0011aabb");
    expect(await getPostgresInstanceAppName(ok as any)).toBe(
      "PoliteDB/0011aabb"
    );
  });
});
