import { check } from "@tauri-apps/plugin-updater";

function isTauriRuntime() {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function shouldRunUpdaterCheck() {
  return isTauriRuntime() && !import.meta.env.DEV;
}

function shouldInstallUpdate(version: string) {
  return window.confirm(
    `A new version (${version}) is available. Download and install now?`
  );
}

function notifyInstalled() {
  window.alert("Update installed. Please restart the app to apply it.");
}

export async function runRuntimeUpdaterCheck() {
  if (!shouldRunUpdaterCheck()) return;

  const update = await check();
  if (!update) return;

  if (!shouldInstallUpdate(update.version)) return;

  await update.downloadAndInstall();
  notifyInstalled();
}
