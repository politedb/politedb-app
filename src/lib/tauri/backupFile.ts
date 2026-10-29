import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

/**
 * A backup file written whole into a temp sibling of the destination and
 * published by rename: the destination keeps its content unless publishing
 * succeeds. Errors are codes (BACKUP_FILE_*):
 * - ALREADY_PUBLISHED: the session was published (also after a lost reply);
 * - TEMP_NOT_REMOVED: abort could not remove the temp (it can be retried,
 *   or forgotten, leaving the file);
 * - WRONG_STATE: e.g. publishing before a successful write.
 */
export const BACKUP_FILE_ALREADY_PUBLISHED = "BACKUP_FILE_ALREADY_PUBLISHED";
export const BACKUP_FILE_TEMP_NOT_REMOVED = "BACKUP_FILE_TEMP_NOT_REMOVED";

export async function backupFileBegin(path: string): Promise<string> {
  return invoke<string>(CMD.backupFileBegin, { path });
}

/** Writes the whole backup, once (sent as raw bytes). */
export async function backupFileWrite(
  sessionId: string,
  bytes: Uint8Array
): Promise<void> {
  await invoke(CMD.backupFileWrite, bytes, {
    headers: { "x-session-id": sessionId },
  });
}

export async function backupFilePublish(sessionId: string): Promise<void> {
  await invoke(CMD.backupFilePublish, { sessionId });
}

export async function backupFileAbort(sessionId: string): Promise<void> {
  await invoke(CMD.backupFileAbort, { sessionId });
}

/** Lets go of a session whose temp could not be removed. */
export async function backupFileForget(sessionId: string): Promise<void> {
  await invoke(CMD.backupFileForget, { sessionId });
}
