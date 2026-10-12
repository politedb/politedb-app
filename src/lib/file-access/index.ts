import { trackEvent } from "src/lib/analytics";
import {
  DISTRIBUTION_FEATURES,
  type DistributionFeatures,
} from "src/lib/distribution";
import { confirmDialog } from "src/lib/system-dialog";
import {
  fileAccessMissing,
  fileAccessPickDatabase,
  fileAccessPickSshKey,
  type FileAccessRequest,
  type FileAccessRole,
} from "src/lib/tauri/fileAccess";
import type { ConnectionCreateInput } from "src/lib/tauri/types";

/**
 * Sandboxed (App Store) builds reach user files only through grants created by the
 * backend pickers. When a connection needs a file without a usable grant, the backend
 * fails with `FILE_ACCESS_REQUIRED:{"role":…}` (never a path); this module asks the
 * user to pick the file again and retries once (plan D19).
 *
 * Paths and error text never go to analytics from here: only `{ role, outcome }`.
 */

export type FileAccessCode =
  | "FILE_ACCESS_REQUIRED"
  | "FILE_ACCESS_UNAVAILABLE"
  | "FILE_ACCESS_DENIED"
  | "FILE_ACCESS_WRONG_FILE"
  | "FILE_ACCESS_FOLDER_TOO_BROAD"
  | "FILE_ACCESS_UNSUPPORTED_ITEM"
  | "FILE_ACCESS_INVALID_PATH"
  | "FILE_ACCESS_STORE_IO"
  | "FILE_ACCESS_STORE_CORRUPT"
  | "FILE_ACCESS_PANEL_FAILED";

export type FileAccessError = { code: FileAccessCode; role?: FileAccessRole };

const CODE_RE = /(FILE_ACCESS_[A-Z_]+)(?::(\{[^}]*\}))?/;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : String(error ?? "");
}

/** Finds a file-access code anywhere in an error (backend layers may prefix it). */
export function parseFileAccessError(error: unknown): FileAccessError | null {
  const match = CODE_RE.exec(errorText(error));
  if (!match) return null;
  let role: FileAccessRole | undefined;
  if (match[2]) {
    try {
      const parsed = JSON.parse(match[2]) as { role?: unknown };
      if (parsed.role === "database_folder" || parsed.role === "ssh_key") {
        role = parsed.role;
      }
    } catch {
      // Malformed payload: keep the code only.
    }
  }
  return { code: match[1] as FileAccessCode, role };
}

/** User-facing text for a file-access error, or `null` for other errors. */
export function describeFileAccessError(error: unknown): string | null {
  const parsed = parseFileAccessError(error);
  if (!parsed) return null;
  const what = parsed.role === "ssh_key" ? "SSH key" : "database file";
  switch (parsed.code) {
    case "FILE_ACCESS_REQUIRED":
      return `PoliteDB needs your permission to open this ${what} again. Choose it to continue.`;
    case "FILE_ACCESS_UNAVAILABLE":
      return `The ${what} or the drive it is on is not available. Reconnect the drive, or edit the connection to choose another file.`;
    case "FILE_ACCESS_WRONG_FILE":
      return "Choose the same file the connection uses (or the folder that contains it). To use another file, edit the connection.";
    case "FILE_ACCESS_FOLDER_TOO_BROAD":
      return "PoliteDB can't ask for access to a whole disk or your home folder. Move the database into its own folder and choose it again.";
    case "FILE_ACCESS_UNSUPPORTED_ITEM":
      return "Aliases, symbolic links and folders can't be used here. Choose the original file.";
    case "FILE_ACCESS_INVALID_PATH":
      return "This file path can't be used. Choose the file with Browse.";
    default:
      return "PoliteDB couldn't get access to the file. Please try again.";
  }
}

/** Files a connection input needs (none for `:memory:` or password SSH). */
export function fileAccessRequests(
  input?: ConnectionCreateInput | null
): FileAccessRequest[] {
  if (!input) return [];
  const requests: FileAccessRequest[] = [];
  const dbPath = input.sqlite?.path ?? input.duckdb?.path;
  if (dbPath && !isInMemoryPath(dbPath)) {
    requests.push({ role: "database_folder", path: dbPath.trim() });
  }
  const auth = input.ssh?.auth;
  if (auth?.kind === "private_key" && auth.identity_file.trim()) {
    requests.push({ role: "ssh_key", path: auth.identity_file.trim() });
  }
  return requests;
}

export function isInMemoryPath(path: string): boolean {
  const trimmed = path.trim();
  return !trimmed || trimmed.toLowerCase() === ":memory:";
}

function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

const pendingGrants = new Map<string, Promise<boolean>>();

/** Opens the picker for one request; concurrent calls for the same file share it. */
export function grantFileAccess(request: FileAccessRequest): Promise<boolean> {
  const key = `${request.role}:${request.path}`;
  const pending = pendingGrants.get(key);
  if (pending) return pending;
  const promise = (async () => {
    try {
      const picked =
        request.role === "ssh_key"
          ? await fileAccessPickSshKey(request.path)
          : await fileAccessPickDatabase("open", request.path);
      trackEvent("file_access_grant", {
        role: request.role,
        outcome: picked ? "granted" : "cancelled",
      });
      return picked !== null;
    } catch (error) {
      trackEvent("file_access_grant", {
        role: request.role,
        outcome: "failed",
      });
      throw error;
    }
  })().finally(() => pendingGrants.delete(key));
  pendingGrants.set(key, promise);
  return promise;
}

/** The user declined or cancelled a file-access prompt; stop without side effects. */
export class FileAccessCancelled extends Error {
  constructor() {
    super("FILE_ACCESS_CANCELLED");
    this.name = "FileAccessCancelled";
  }
}

export function isFileAccessCancelled(error: unknown): boolean {
  return error instanceof FileAccessCancelled;
}

const pendingEnsures = new Map<string, Promise<boolean>>();

function requestKey(requests: FileAccessRequest[]): string {
  return requests
    .map((r) => `${r.role}:${r.path}`)
    .sort()
    .join("|");
}

/**
 * Makes sure every file in `requests` has a usable grant, asking the user first
 * (skip with `confirm: false` when the user already clicked a "Grant Access" action).
 * Resolves `false` if the user declines or cancels a picker. `force` adds requests
 * whose grant failed at use time. Concurrent calls for the same files share one
 * prompt-and-picker transaction.
 */
export function ensureFileAccess(
  requests: FileAccessRequest[],
  options: { force?: FileAccessRequest[]; confirm?: boolean } = {},
  features: DistributionFeatures = DISTRIBUTION_FEATURES
): Promise<boolean> {
  if (!features.fileGrants || requests.length === 0) {
    return Promise.resolve(true);
  }
  const key = `${requestKey(requests)}#${requestKey(options.force ?? [])}`;
  const pending = pendingEnsures.get(key);
  if (pending) return pending;
  const promise = runEnsure(requests, options).finally(() =>
    pendingEnsures.delete(key)
  );
  pendingEnsures.set(key, promise);
  return promise;
}

async function runEnsure(
  requests: FileAccessRequest[],
  options: { force?: FileAccessRequest[]; confirm?: boolean }
): Promise<boolean> {
  const missing = await fileAccessMissing(requests);
  for (const forced of options.force ?? []) {
    if (
      !missing.some((m) => m.role === forced.role && m.path === forced.path)
    ) {
      missing.push(forced);
    }
  }
  if (missing.length === 0) return true;

  if (options.confirm !== false) {
    const names = missing.map((m) => `“${basename(m.path)}”`).join(", ");
    const ok = await confirmDialog(
      `PoliteDB needs your permission to open ${names}. Choose ${
        missing.length > 1 ? "them" : "it"
      } in the next window${
        missing.some((m) => m.role === "database_folder")
          ? " and allow access to the folder that contains the database"
          : ""
      }.`,
      { title: "Allow File Access", okLabel: "Continue", kind: "info" }
    );
    if (!ok) return false;
  }
  for (const request of missing) {
    if (!(await grantFileAccess(request))) return false;
  }
  return true;
}

/**
 * Asks for any missing file access, then runs `run`. If `run` still fails with
 * `FILE_ACCESS_REQUIRED` and `retryIf` allows it (the failure happened before anything
 * was persisted), asks again and retries once. Declining or cancelling throws
 * {@link FileAccessCancelled} before `run` is called.
 */
export async function withFileAccessRecovery<T>(
  run: () => Promise<T>,
  requests: FileAccessRequest[],
  options: { retryIf?: (error: unknown) => boolean } = {},
  features: DistributionFeatures = DISTRIBUTION_FEATURES
): Promise<T> {
  if (!features.fileGrants) return run();
  if (!(await ensureFileAccess(requests, {}, features))) {
    throw new FileAccessCancelled();
  }
  try {
    return await run();
  } catch (error) {
    const parsed = parseFileAccessError(error);
    if (parsed?.code !== "FILE_ACCESS_REQUIRED") throw error;
    if (options.retryIf && !options.retryIf(error)) throw error;
    const failed = requests.filter(
      (r) => !parsed.role || r.role === parsed.role
    );
    const granted = await ensureFileAccess(
      requests,
      { force: failed },
      features
    );
    if (!granted) throw new FileAccessCancelled();
    return run();
  }
}

/**
 * For save-and-connect: retry only when the backend refused before saving anything
 * (its pre-persistence check returns the bare code; later failures are prefixed).
 */
export function failedBeforePersistence(error: unknown): boolean {
  return errorText(error).trimStart().startsWith("FILE_ACCESS_");
}
