/**
 * Restores localStorage left by builds before 1.5, when the bundle identifier was
 * `com.politehq.politedb` and the WebView kept its store under that name (plan
 * legacy-webkit-storage). Runs once, first thing at startup.
 */

export const LEGACY_STORAGE_MARKER_KEY =
  "politedb.migration.legacyWebStorage.v1";
export const LEGACY_STORAGE_ATTEMPTS_KEY =
  "politedb.migration.legacyWebStorage.attempts";
const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 3000;

type Entry = { key: string; value: string };
type StorageLike = Pick<Storage, "getItem" | "setItem">;

export type LegacyStorageDeps = {
  read: () => Promise<{ entries: Entry[] }>;
  /** Called inside the guard: `window.localStorage` itself can throw. */
  storage: () => StorageLike;
  timeoutMs?: number;
};

/**
 * - `"done"`: nothing to do, or done earlier.
 * - `"restored"`: keys were written; reload so modules that read localStorage at
 *   import time start from them.
 * - `"failed"`: nothing was written; retried on a later launch (up to 3 attempts).
 */
export type LegacyStorageOutcome = "done" | "restored" | "failed";

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Counts a failed attempt; after the last one, stops retrying for good. */
function recordFailedAttempt(storage: StorageLike) {
  try {
    const attempts =
      Number(storage.getItem(LEGACY_STORAGE_ATTEMPTS_KEY) ?? "0") + 1;
    if (!Number.isFinite(attempts) || attempts >= MAX_ATTEMPTS) {
      storage.setItem(LEGACY_STORAGE_MARKER_KEY, "gave-up");
    } else {
      storage.setItem(LEGACY_STORAGE_ATTEMPTS_KEY, String(attempts));
    }
  } catch {}
}

export async function restoreLegacyWebStorage(
  deps: LegacyStorageDeps
): Promise<LegacyStorageOutcome> {
  let storage: StorageLike;
  try {
    storage = deps.storage();
    if (storage.getItem(LEGACY_STORAGE_MARKER_KEY) !== null) return "done";
  } catch {
    // No usable localStorage: nothing to restore into. Startup continues.
    return "done";
  }

  let entries: Entry[];
  try {
    entries = (await withTimeout(deps.read(), deps.timeoutMs ?? TIMEOUT_MS))
      .entries;
  } catch {
    recordFailedAttempt(storage);
    return "failed";
  }

  let written = 0;
  let failed = 0;
  for (const { key, value } of entries) {
    try {
      // Values set since 1.5 always win.
      if (storage.getItem(key) !== null) continue;
      storage.setItem(key, value);
      written += 1;
    } catch {
      // Quota or storage failure on this entry: later (often smaller) entries
      // still get their chance.
      failed += 1;
    }
  }

  if (failed > 0) {
    // Incomplete: keep what was written and retry the rest on a later launch.
    recordFailedAttempt(storage);
  } else {
    try {
      storage.setItem(LEGACY_STORAGE_MARKER_KEY, String(Date.now()));
    } catch {
      recordFailedAttempt(storage);
    }
  }
  // Each reload follows at least one new write, and written keys are skipped on
  // the next run, so reloads always stop.
  return written > 0 ? "restored" : failed > 0 ? "failed" : "done";
}
