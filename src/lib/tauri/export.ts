import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

export type ExportAppendPayload = {
  path: string;
  content: string;
  append: boolean;
};

export async function exportAppendToFile(
  payload: ExportAppendPayload
): Promise<void> {
  await invoke(CMD.exportAppendToFile, payload);
}
