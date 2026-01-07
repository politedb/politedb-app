import { invoke } from "@tauri-apps/api/core";
import type {
  ConnectionCreateInput,
  ConnectionInfo,
  ConnectionTestSecrets,
} from "./types";
import { CMD } from "./commands";

/* ============================================================================
 * Connection (runtime)
 * ============================================================================
 */

export async function connectionTest(
  input: ConnectionCreateInput,
  secrets?: ConnectionTestSecrets
): Promise<void> {
  await invoke(CMD.connectionTest, {
    payload: {
      input,
      secrets,
    },
  });
}

export async function connectionList(): Promise<ConnectionInfo[]> {
  return invoke<ConnectionInfo[]>(CMD.connectionList);
}

export async function connectionRemove(connectionId: string): Promise<void> {
  await invoke(CMD.connectionRemove, { connectionId });
}
