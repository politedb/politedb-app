import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

/* ============================================================================
 * Secrets (Keychain)
 * ============================================================================
 */

export async function secretsSet(key: string, value: string): Promise<void> {
  await invoke(CMD.secretsSet, { key, value });
}

export async function secretsDelete(key: string): Promise<void> {
  await invoke(CMD.secretsDelete, { key });
}

// (Optional)
// export async function secretsGet(key: string): Promise<string> {
//   return invoke<string>("secrets_get", { key });
// }
