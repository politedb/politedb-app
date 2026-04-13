import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

export async function securityTouchIdAuthenticate(
  reason?: string
): Promise<boolean> {
  return invoke<boolean>(CMD.securityTouchIdAuthenticate, { reason });
}
