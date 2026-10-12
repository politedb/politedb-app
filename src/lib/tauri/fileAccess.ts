import { invoke } from "@tauri-apps/api/core";
import { CMD } from "./commands";

export type FileAccessRole = "database_folder" | "ssh_key";

/** A file a connection needs; for `database_folder` the path is the database file. */
export type FileAccessRequest = { role: FileAccessRole; path: string };

/**
 * Opens the system panel(s) for a SQLite/DuckDB file. Sandboxed builds also ask for the
 * file's folder and remember it. With `expectedPath`, only access for that saved path
 * is requested. Resolves `null` when the user cancels.
 */
export async function fileAccessPickDatabase(
  mode: "open" | "create",
  expectedPath?: string
): Promise<string | null> {
  return invoke<string | null>(CMD.fileAccessPickDatabase, {
    mode,
    expectedPath: expectedPath ?? null,
  });
}

/** Opens the system panel for an SSH private key (read-only grant when sandboxed). */
export async function fileAccessPickSshKey(
  expectedPath?: string
): Promise<string | null> {
  return invoke<string | null>(CMD.fileAccessPickSshKey, {
    expectedPath: expectedPath ?? null,
  });
}

/** Requests without a stored grant (always empty in direct builds). */
export async function fileAccessMissing(
  requests: FileAccessRequest[]
): Promise<FileAccessRequest[]> {
  return invoke<FileAccessRequest[]>(CMD.fileAccessMissing, { requests });
}
