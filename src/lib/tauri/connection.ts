import { invoke } from "@tauri-apps/api/core";
import type { ConnectionCreateInput, ConnectionInfo } from "./types";
import { CMD } from "./commands";

/* ============================================================================
 * Connection (runtime)
 * ============================================================================
 */

export async function connectionTest(
  input: ConnectionCreateInput
): Promise<void> {
  await invoke(CMD.connectionTest, { input });
}

export async function connectionCreate(
  input: ConnectionCreateInput
): Promise<ConnectionInfo> {
  return invoke<ConnectionInfo>(CMD.connectionCreate, { input });
}

export async function connectionList(): Promise<ConnectionInfo[]> {
  return invoke<ConnectionInfo[]>(CMD.connectionList);
}

export async function connectionRemove(connectionId: string): Promise<void> {
  await invoke(CMD.connectionRemove, { connection_id: connectionId });
}
