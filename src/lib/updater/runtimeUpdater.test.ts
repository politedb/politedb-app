import { afterEach, describe, expect, it, vi } from "vitest";
import {
  coalesceUpdaterCheck,
  resetRuntimeUpdaterCheckState,
  UPDATER_CHECK_MIN_INTERVAL_MS,
  type RuntimeUpdate,
} from "./runtimeUpdater";

afterEach(() => {
  resetRuntimeUpdaterCheckState();
});

function updateStub(version: string): RuntimeUpdate {
  return { version } as RuntimeUpdate;
}

describe("coalesceUpdaterCheck", () => {
  it("reuses one in-flight check", async () => {
    let resolveCheck: (value: RuntimeUpdate | null) => void = () => {};
    const run = vi.fn(
      () =>
        new Promise<RuntimeUpdate | null>((resolve) => {
          resolveCheck = resolve;
        })
    );

    const first = coalesceUpdaterCheck(run);
    const second = coalesceUpdaterCheck(run);
    expect(run).toHaveBeenCalledTimes(1);

    resolveCheck(null);
    await expect(first).resolves.toBeNull();
    await expect(second).resolves.toBeNull();
  });

  it("returns the cached result inside the min interval", async () => {
    const update = updateStub("1.2.10");
    const run = vi.fn(async (): Promise<RuntimeUpdate | null> => update);
    const firstAt = 1_000;

    await expect(coalesceUpdaterCheck(run, firstAt)).resolves.toEqual(update);
    await expect(
      coalesceUpdaterCheck(run, firstAt + UPDATER_CHECK_MIN_INTERVAL_MS - 1)
    ).resolves.toEqual(update);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("checks again after the min interval", async () => {
    const run = vi.fn(
      async (): Promise<RuntimeUpdate | null> => updateStub("1.2.10")
    );
    const firstAt = 1_000;

    await coalesceUpdaterCheck(run, firstAt);
    await coalesceUpdaterCheck(run, firstAt + UPDATER_CHECK_MIN_INTERVAL_MS);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("retries after a failed check", async () => {
    const update = updateStub("1.2.10");
    const run = vi
      .fn<() => Promise<RuntimeUpdate | null>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(update);

    await expect(coalesceUpdaterCheck(run, 1_000)).resolves.toBeNull();
    await expect(coalesceUpdaterCheck(run, 1_001)).resolves.toEqual(update);
    expect(run).toHaveBeenCalledTimes(2);
  });
});
