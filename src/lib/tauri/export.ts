import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

export type ExportAppendPayload = {
  path: string;
  content: string;
  append: boolean;
};

export type ExportSessionBeginResult = {
  sessionId: string;
};

export type ExportSessionAppendPayload = {
  sessionId: string;
  content: string;
  /** Ignored by session writers (always append to temp); kept for API clarity. */
  append?: boolean;
};

/** Legacy direct append. Prefer export session APIs for new exports. */
export async function exportAppendToFile(
  payload: ExportAppendPayload
): Promise<void> {
  await invoke(CMD.exportAppendToFile, payload);
}

/** Begin a scoped export session writing to an exclusive temp sibling of `path`. */
export async function exportSessionBegin(
  path: string
): Promise<ExportSessionBeginResult> {
  return invoke(CMD.exportSessionBegin, { path });
}

/** Append transformed content to the session temp file only. */
export async function exportSessionAppend(
  payload: ExportSessionAppendPayload
): Promise<void> {
  await invoke(CMD.exportSessionAppend, {
    sessionId: payload.sessionId,
    content: payload.content,
  });
}

/** Publish temp → final after successful flush/close. */
export async function exportSessionPublish(sessionId: string): Promise<void> {
  await invoke(CMD.exportSessionPublish, { sessionId });
}

/** Abort: delete only the session-owned temp file (never the final path). */
export async function exportSessionAbort(sessionId: string): Promise<void> {
  await invoke(CMD.exportSessionAbort, { sessionId });
}
