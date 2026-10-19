import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  activate: vi.fn(),
}));

vi.mock("src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri")>()),
  licenseStateLoad: (...a: unknown[]) => mocks.load(...a),
  licenseActivate: (...a: unknown[]) => mocks.activate(...a),
  licenseRefresh: vi.fn().mockResolvedValue(null),
}));

import { hasProAccessNow, useLicenseStore } from "./license";

function snapshot(
  seq: number,
  extra: Partial<LicenseState> = {}
): LicenseState {
  return {
    status: "inactive",
    pro_access: false,
    pro_access_until: null,
    snapshot_seq: seq,
    ...extra,
  } as LicenseState;
}

beforeEach(() => {
  vi.clearAllMocks();
  useLicenseStore.setState({
    state: null,
    publishedSeq: 0,
    busy: false,
    error: null,
    loaded: false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("license store publication", () => {
  it("ignores a snapshot older than the one shown", async () => {
    mocks.load.mockResolvedValueOnce(snapshot(5, { status: "active" }));
    await useLicenseStore.getState().reload();
    mocks.load.mockResolvedValueOnce(snapshot(3, { status: "inactive" }));
    await useLicenseStore.getState().reload();
    expect(useLicenseStore.getState().state?.status).toBe("active");
    expect(useLicenseStore.getState().publishedSeq).toBe(5);
  });

  it("publishes the snapshot a failed command carries", async () => {
    mocks.activate.mockRejectedValueOnce({
      kind: "timeout",
      message: "The license server did not respond in time.",
      state: snapshot(9, { status: "inactive" }),
    });
    await expect(useLicenseStore.getState().activate("KEY")).rejects.toThrow(
      "did not respond"
    );
    const store = useLicenseStore.getState();
    expect(store.publishedSeq).toBe(9);
    expect(store.error).toMatch(/did not respond/);
    expect(store.busy).toBe(false);
  });

  it("re-reads when Pro access ends and locks without a restart", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mocks.load.mockResolvedValueOnce(
      snapshot(1, { pro_access: true, pro_access_until: now + 1_000 })
    );
    await useLicenseStore.getState().reload();
    expect(hasProAccessNow()).toBe(true);

    // Same revision on disk, newer snapshot: access is gone.
    mocks.load.mockResolvedValueOnce(snapshot(2, { pro_access: false }));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(useLicenseStore.getState().state?.pro_access).toBe(false);
    expect(hasProAccessNow()).toBe(false);
  });

  it("denies at the deadline even before the re-read lands", () => {
    vi.useFakeTimers();
    const now = Date.now();
    useLicenseStore.setState({
      state: snapshot(1, { pro_access: true, pro_access_until: now + 500 }),
    });
    expect(hasProAccessNow()).toBe(true);
    vi.setSystemTime(now + 500);
    expect(hasProAccessNow()).toBe(false);
  });

  it("notifies every subscriber when the timer re-read locks access", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mocks.load.mockResolvedValueOnce(
      snapshot(1, { pro_access: true, pro_access_until: now + 1_000 })
    );
    await useLicenseStore.getState().reload();
    const seen: boolean[][] = [[], []];
    const unsubscribe = seen.map((log) =>
      useLicenseStore.subscribe((store) =>
        log.push(store.state?.pro_access === true)
      )
    );
    mocks.load.mockResolvedValueOnce(snapshot(2, { pro_access: false }));
    await vi.advanceTimersByTimeAsync(1_100);
    for (const log of seen) expect(log[log.length - 1]).toBe(false);
    unsubscribe.forEach((stop) => stop());
  });

  it("re-reads when the window regains focus", async () => {
    mocks.load.mockResolvedValue(snapshot(1, { pro_access: true }));
    await useLicenseStore.getState().load();
    mocks.load.mockResolvedValue(snapshot(2, { pro_access: false }));
    window.dispatchEvent(new Event("focus"));
    await vi.waitFor(() =>
      expect(useLicenseStore.getState().state?.pro_access).toBe(false)
    );
  });
});
