import { describe, expect, it, vi } from "vitest";
import {
  LEGACY_STORAGE_ATTEMPTS_KEY,
  LEGACY_STORAGE_MARKER_KEY,
  restoreLegacyWebStorage,
} from "./legacyWebStorage";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

const entries = [
  { key: "politedb:app-settings:v1", value: '{"theme":"dark"}' },
  { key: "politedb.connection-groups.v1", value: '{"groups":[]}' },
];

describe("restoreLegacyWebStorage", () => {
  it("does nothing once the marker is set", async () => {
    const storage = memoryStorage({ [LEGACY_STORAGE_MARKER_KEY]: "1" });
    const read = vi.fn();
    expect(
      await restoreLegacyWebStorage({ read, storage: () => storage })
    ).toBe("done");
    expect(read).not.toHaveBeenCalled();
  });

  it("fills missing keys only and never overwrites values set since 1.5", async () => {
    const storage = memoryStorage({
      "politedb:app-settings:v1": '{"theme":"light"}',
    });
    const outcome = await restoreLegacyWebStorage({
      read: async () => ({ entries }),
      storage: () => storage,
    });
    expect(outcome).toBe("restored");
    expect(storage.map.get("politedb:app-settings:v1")).toBe(
      '{"theme":"light"}'
    );
    expect(storage.map.get("politedb.connection-groups.v1")).toBe(
      '{"groups":[]}'
    );
    expect(storage.map.has(LEGACY_STORAGE_MARKER_KEY)).toBe(true);
  });

  it("does not ask for a reload when nothing was written", async () => {
    const storage = memoryStorage({
      "politedb:app-settings:v1": "a",
      "politedb.connection-groups.v1": "b",
    });
    expect(
      await restoreLegacyWebStorage({
        read: async () => ({ entries }),
        storage: () => storage,
      })
    ).toBe("done");
    expect(
      await restoreLegacyWebStorage({
        read: async () => ({ entries: [] }),
        storage: () => memoryStorage(),
      })
    ).toBe("done");
    expect(storage.map.has(LEGACY_STORAGE_MARKER_KEY)).toBe(true);
  });

  it("runs once: a second launch does not read again", async () => {
    const storage = memoryStorage();
    const read = vi.fn(async () => ({ entries }));
    expect(
      await restoreLegacyWebStorage({ read, storage: () => storage })
    ).toBe("restored");
    expect(
      await restoreLegacyWebStorage({ read, storage: () => storage })
    ).toBe("done");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("retries a failed read on later launches, then gives up after 3", async () => {
    const storage = memoryStorage();
    const read = vi.fn(async () => {
      throw new Error("LEGACY_STORAGE_UNREADABLE");
    });
    expect(
      await restoreLegacyWebStorage({ read, storage: () => storage })
    ).toBe("failed");
    expect(storage.map.get(LEGACY_STORAGE_ATTEMPTS_KEY)).toBe("1");
    expect(storage.map.has(LEGACY_STORAGE_MARKER_KEY)).toBe(false);
    expect(
      await restoreLegacyWebStorage({ read, storage: () => storage })
    ).toBe("failed");
    expect(
      await restoreLegacyWebStorage({ read, storage: () => storage })
    ).toBe("failed");
    expect(storage.map.has(LEGACY_STORAGE_MARKER_KEY)).toBe(true);
    expect(
      await restoreLegacyWebStorage({ read, storage: () => storage })
    ).toBe("done");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("treats a slow read as a failure", async () => {
    vi.useFakeTimers();
    try {
      const storage = memoryStorage();
      const pending = restoreLegacyWebStorage({
        read: () => new Promise(() => {}),
        storage: () => storage,
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toBe("failed");
      expect(storage.map.get(LEGACY_STORAGE_ATTEMPTS_KEY)).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not loop when the marker cannot be written", async () => {
    const storage = memoryStorage();
    const failing = {
      getItem: storage.getItem,
      setItem: (key: string, value: string) => {
        if (key === LEGACY_STORAGE_MARKER_KEY) throw new Error("quota");
        storage.setItem(key, value);
      },
    };
    const run = () =>
      restoreLegacyWebStorage({
        read: async () => ({ entries }),
        storage: () => failing,
      });
    // Writes happened, so one reload; the next run writes nothing and stops.
    expect(await run()).toBe("restored");
    expect(await run()).toBe("done");
  });

  it("keeps going after a failed write and retries the rest later", async () => {
    const storage = memoryStorage();
    let full = true;
    const quota = {
      getItem: storage.getItem,
      setItem: (key: string, value: string) => {
        if (full && key === "politedb:app-settings:v1")
          throw new Error("quota");
        storage.setItem(key, value);
      },
    };
    const read = vi.fn(async () => ({ entries }));
    const run = () => restoreLegacyWebStorage({ read, storage: () => quota });

    // The first entry fails; the later one is still written.
    expect(await run()).toBe("restored");
    expect(storage.map.get("politedb.connection-groups.v1")).toBe(
      '{"groups":[]}'
    );
    expect(storage.map.has("politedb:app-settings:v1")).toBe(false);
    expect(storage.map.has(LEGACY_STORAGE_MARKER_KEY)).toBe(false);
    expect(storage.map.get(LEGACY_STORAGE_ATTEMPTS_KEY)).toBe("1");

    // Space frees up: the next launch fills the rest and completes.
    full = false;
    expect(await run()).toBe("restored");
    expect(storage.map.get("politedb:app-settings:v1")).toBe(
      '{"theme":"dark"}'
    );
    expect(storage.map.has(LEGACY_STORAGE_MARKER_KEY)).toBe(true);
    expect(await run()).toBe("done");
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("gives up after 3 incomplete imports", async () => {
    const storage = memoryStorage();
    const quota = {
      getItem: storage.getItem,
      setItem: (key: string, value: string) => {
        if (key === "politedb:app-settings:v1") throw new Error("quota");
        storage.setItem(key, value);
      },
    };
    const read = vi.fn(async () => ({ entries }));
    const run = () => restoreLegacyWebStorage({ read, storage: () => quota });
    expect(await run()).toBe("restored");
    expect(await run()).toBe("failed");
    expect(await run()).toBe("failed");
    expect(storage.map.get(LEGACY_STORAGE_MARKER_KEY)).toBe("gave-up");
    expect(await run()).toBe("done");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("is a no-op when localStorage is unavailable", async () => {
    const read = vi.fn();
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    expect(await restoreLegacyWebStorage({ read, storage: () => broken })).toBe(
      "done"
    );
    // The `window.localStorage` getter itself can throw (SecurityError).
    expect(
      await restoreLegacyWebStorage({
        read,
        storage: () => {
          throw new DOMException("denied", "SecurityError");
        },
      })
    ).toBe("done");
    expect(read).not.toHaveBeenCalled();
  });
});
