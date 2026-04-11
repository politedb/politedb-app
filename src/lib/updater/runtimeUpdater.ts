import { invoke } from "@tauri-apps/api/core";
import { check } from "@tauri-apps/plugin-updater";
import { CMD } from "src/lib/tauri/commands";

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
  void update;
  await invoke<void>(CMD.updaterInstallIfAllowed);
}
