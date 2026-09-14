import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { CMD } from "src/lib/tauri/commands";

export const UPDATER_CHECK_MIN_INTERVAL_MS = 60_000;

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function shouldRunUpdaterCheck() {
  return isTauriRuntime() && !import.meta.env.DEV;
}

export type RuntimeUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

type CheckState = {
  inFlight: Promise<RuntimeUpdate | null> | null;
  lastCheckAt: number;
  lastResult: RuntimeUpdate | null;
};

const checkState: CheckState = {
  inFlight: null,
  lastCheckAt: 0,
  lastResult: null,
};

export function resetRuntimeUpdaterCheckState() {
  checkState.inFlight = null;
  checkState.lastCheckAt = 0;
  checkState.lastResult = null;
}

export async function coalesceUpdaterCheck(
  run: () => Promise<RuntimeUpdate | null>,
  now = Date.now()
): Promise<RuntimeUpdate | null> {
  if (checkState.inFlight) return checkState.inFlight;
  if (
    checkState.lastCheckAt > 0 &&
    now - checkState.lastCheckAt < UPDATER_CHECK_MIN_INTERVAL_MS
  ) {
    return checkState.lastResult;
  }

  checkState.inFlight = (async () => {
    try {
      const result = await run();
      checkState.lastResult = result;
      checkState.lastCheckAt = now;
      return result;
    } catch {
      return checkState.lastResult;
    } finally {
      checkState.inFlight = null;
    }
  })();

  return checkState.inFlight;
}

export async function checkForRuntimeUpdate(): Promise<RuntimeUpdate | null> {
  if (!shouldRunUpdaterCheck()) return null;
  return coalesceUpdaterCheck(() => check());
}

export async function installRuntimeUpdate(update: RuntimeUpdate) {
  void update;
  await invoke<void>(CMD.updaterInstallIfAllowed);
}
