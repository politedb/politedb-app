import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

export function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function shouldRunUpdaterCheck() {
  return isTauriRuntime() && !import.meta.env.DEV;
}

export type RuntimeUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

export async function checkForRuntimeUpdate(): Promise<RuntimeUpdate | null> {
  if (!shouldRunUpdaterCheck()) return null;
  return check();
}

export async function installRuntimeUpdate(update: RuntimeUpdate) {
  await update.downloadAndInstall();
  await relaunch();
}
