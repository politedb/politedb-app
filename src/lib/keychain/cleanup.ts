import { keychainDisplay, type KeychainNameSources } from "./display";

export type UnusedKeyCleanup = {
  deleted: string[];
  failed: Array<{ key: string; error: string }>;
  /** Keys that turned out to be in use when checked again. */
  skipped: string[];
};

/**
 * Deletes keychain entries that no connection or AI provider uses. The owner
 * lists are loaded again right before deleting, so a key that became (or was
 * all along) in use is skipped; if they cannot be loaded nothing is deleted and
 * the error propagates. Each key is deleted on its own and failures are
 * collected rather than stopping the rest.
 */
export async function deleteUnusedKeys(
  candidates: readonly string[],
  deps: {
    loadOwners: () => Promise<Required<KeychainNameSources>>;
    deleteKey: (key: string) => Promise<void>;
  }
): Promise<UnusedKeyCleanup> {
  const owners = await deps.loadOwners();
  const result: UnusedKeyCleanup = { deleted: [], failed: [], skipped: [] };
  for (const key of candidates) {
    if (!keychainDisplay(key, owners).unused) {
      result.skipped.push(key);
      continue;
    }
    try {
      await deps.deleteKey(key);
      result.deleted.push(key);
    } catch (e) {
      result.failed.push({
        key,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return result;
}

/** One line describing a cleanup, for the page notice. */
export function describeUnusedKeyCleanup(result: UnusedKeyCleanup): string {
  const plural = (n: number) => (n === 1 ? "key" : "keys");
  const parts: string[] = [];
  if (result.deleted.length)
    parts.push(
      `Deleted ${result.deleted.length} unused ${plural(result.deleted.length)}.`
    );
  if (result.failed.length)
    parts.push(
      `Could not delete ${result.failed.length} ${plural(result.failed.length)}: ${result.failed[0]!.error}`
    );
  if (result.skipped.length)
    parts.push(
      `Kept ${result.skipped.length} ${plural(result.skipped.length)} that ${result.skipped.length === 1 ? "is" : "are"} in use now.`
    );
  return parts.join(" ") || "Nothing to delete.";
}
