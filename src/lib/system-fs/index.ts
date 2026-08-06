/**
 * Native filesystem I/O (Tauri). Use this instead of importing @tauri-apps/plugin-fs
 * directly so behavior is consistent and browser/dev without Tauri degrades safely.
 */
import {
  readFile as tauriReadFile,
  readTextFile as tauriReadTextFile,
  writeFile as tauriWriteFile,
  writeTextFile as tauriWriteTextFile,
} from "@tauri-apps/plugin-fs";

function isTauriRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    !!(window as unknown as { __TAURI_INTERNALS__?: unknown })
      .__TAURI_INTERNALS__
  );
}

export async function readTextFile(path: string): Promise<string> {
  if (!isTauriRuntime()) {
    throw new Error("Filesystem access requires the desktop app.");
  }
  return tauriReadTextFile(path);
}

export async function readFile(path: string): Promise<Uint8Array> {
  if (!isTauriRuntime()) {
    throw new Error("Filesystem access requires the desktop app.");
  }
  return tauriReadFile(path);
}

export async function writeTextFile(
  path: string,
  contents: string
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Filesystem access requires the desktop app.");
  }
  await tauriWriteTextFile(path, contents);
}

export async function writeFile(
  path: string,
  contents: Uint8Array
): Promise<void> {
  if (!isTauriRuntime()) {
    throw new Error("Filesystem access requires the desktop app.");
  }
  await tauriWriteFile(path, contents);
}
