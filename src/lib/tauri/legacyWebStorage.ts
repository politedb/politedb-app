import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

export type LegacyWebStorage = {
  entries: { key: string; value: string }[];
  skipped: number;
};

/** Allowlisted localStorage entries left by builds before the 1.5 identifier change. */
export function readLegacyWebStorage(): Promise<LegacyWebStorage> {
  return invoke<LegacyWebStorage>(CMD.legacyWebStorageRead);
}
