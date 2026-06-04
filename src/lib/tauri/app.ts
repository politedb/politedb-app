import { invoke } from "@tauri-apps/api/core";

export async function appQuit(): Promise<void> {
  await invoke("app_quit");
}
