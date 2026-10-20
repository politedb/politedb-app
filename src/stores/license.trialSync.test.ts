import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LicenseState } from "src/lib/tauri";

const mocks = vi.hoisted(() => ({
  sync: vi.fn(),
  load: vi.fn(),
}));

vi.mock("src/lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("src/lib/tauri")>()),
  licenseTrialSync: (...a: unknown[]) => mocks.sync(...a),
  licenseStateLoad: (...a: unknown[]) => mocks.load(...a),
  licenseRefresh: vi.fn().mockResolvedValue(null),
}));

import {
  requestTrialSync,
  resetTrialSyncForTests,
  useLicenseStore,
} from "./license";

let seq = 0;
function snapshot(extra: Partial<LicenseState> = {}): LicenseState {
  seq += 1;
  return {
    status: "inactive",
    pro_access: false,
    snapshot_seq: seq,
    ...extra,
  } as LicenseState;
}

const HOUR = 60 * 60 * 1000;

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  // The scheduler only runs with a license API configured.
  vi.stubEnv("VITE_POLITEDB_API_BASE", "https://api.test/api/v1");
  vi.useFakeTimers();
  vi.clearAllMocks();
  resetTrialSyncForTests();
  useLicenseStore.setState({
    state: null,
    publishedSeq: 0,
    trialSync: { status: "idle", lastOkAt: null },
    busy: false,
    loaded: false,
  });
  mocks.load.mockImplementation(async () => snapshot());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("trial sync scheduler", () => {
  it("syncs on load, then waits six hours; focus does not repeat it", async () => {
    mocks.sync.mockImplementation(async () => snapshot({ pro_access: true }));
    await useLicenseStore.getState().load();
    await settle();
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    expect(mocks.sync.mock.calls[0][0]).toEqual({
      apiBase: "https://api.test/api/v1",
      product: "politedb",
    });
    expect(useLicenseStore.getState().trialSync.status).toBe("verified");
    expect(useLicenseStore.getState().state?.pro_access).toBe(true);

    requestTrialSync("focus");
    requestTrialSync("online");
    await vi.advanceTimersByTimeAsync(5 * HOUR);
    expect(mocks.sync).toHaveBeenCalledTimes(1);

    mocks.sync.mockImplementation(async () => snapshot({ pro_access: true }));
    await vi.advanceTimersByTimeAsync(1 * HOUR + 10);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it("runs one request at a time", async () => {
    let finish: (value: LicenseState) => void = () => {};
    mocks.sync.mockImplementation(
      () => new Promise<LicenseState>((resolve) => (finish = resolve))
    );
    requestTrialSync("load");
    requestTrialSync("online");
    requestTrialSync("timer");
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    finish(snapshot());
    await settle();
  });

  it("backs off after failures and retries without any event", async () => {
    mocks.sync.mockRejectedValue({ kind: "network", message: "offline" });
    requestTrialSync("load");
    await settle();
    expect(useLicenseStore.getState().trialSync.status).toBe("unavailable");
    requestTrialSync("timer");
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.sync).toHaveBeenCalledTimes(3);
  });

  it("retries at once when the network comes back after a network failure", async () => {
    mocks.sync.mockRejectedValueOnce({ kind: "network", message: "offline" });
    requestTrialSync("load");
    await settle();
    mocks.sync.mockImplementation(async () => snapshot());
    requestTrialSync("online");
    await settle();
    expect(mocks.sync).toHaveBeenCalledTimes(2);
    expect(useLicenseStore.getState().trialSync.status).toBe("verified");
  });

  it("honours Retry-After on 429", async () => {
    mocks.sync.mockRejectedValueOnce({
      kind: "http",
      status: 429,
      retryAfterMs: 120_000,
      message: "RATE_LIMITED",
    });
    requestTrialSync("load");
    await settle();
    mocks.sync.mockImplementation(async () => snapshot());
    await vi.advanceTimersByTimeAsync(119_000);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it("stops after a 400 until the app restarts, even across reloads", async () => {
    mocks.sync.mockRejectedValue({
      kind: "http",
      status: 400,
      message: "TRIAL_PRODUCT_UNSUPPORTED",
    });
    requestTrialSync("load");
    await settle();
    await useLicenseStore.getState().reload();
    requestTrialSync("online");
    await vi.advanceTimersByTimeAsync(24 * HOUR);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
  });

  it("publishes the snapshot a failed sync carries, keeping a known trial", async () => {
    const known = snapshot({
      pro_access: true,
      trial: { started_at: 1, expires_at: 2, synced_at: 1 },
    });
    mocks.sync.mockRejectedValue({
      kind: "timeout",
      message: "slow",
      state: known,
    });
    requestTrialSync("load");
    await settle();
    expect(useLicenseStore.getState().state?.trial).toEqual(known.trial);
  });

  it("keeps its retry timer when the license is re-read at expiry", async () => {
    mocks.sync.mockRejectedValueOnce({ kind: "network", message: "offline" });
    requestTrialSync("load");
    await settle();
    await useLicenseStore.getState().reload();
    mocks.sync.mockImplementation(async () => snapshot());
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });

  it("waits out a Retry-After longer than a timer can hold", async () => {
    const DAY = 24 * HOUR;
    mocks.sync.mockRejectedValueOnce({
      kind: "http",
      status: 429,
      retryAfterMs: 30 * DAY,
      message: "RATE_LIMITED",
    });
    requestTrialSync("load");
    await settle();
    mocks.sync.mockImplementation(async () => snapshot());
    // Intermediate wakes only re-arm; nothing runs before the deadline.
    await vi.advanceTimersByTimeAsync(29 * DAY);
    expect(mocks.sync).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(DAY + 1_000);
    expect(mocks.sync).toHaveBeenCalledTimes(2);
  });
});
