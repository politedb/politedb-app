import { normalizeSqlError } from "src/lib/tauri/queryValidate";

/** Every failure of one save run (patches, new tables, objects). */
export class SaveJobsError extends Error {
  constructor(readonly failures: unknown[]) {
    super(failures.map(errorText).join("\n"));
    this.name = "SaveJobsError";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * Run the save jobs together and settle only when every one has finished,
 * so nothing is still writing when the caller reports or retries. Rejects
 * with all failures at once.
 */
export async function runSaveJobs(jobs: Array<Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(jobs);
  const failures = results
    .filter((r): r is PromiseRejectedResult => r.status === "rejected")
    .map((r) => r.reason);
  if (failures.length) throw new SaveJobsError(failures);
}

/**
 * The messages a save review shows: what the jobs reported, plus any
 * rejection they did not already report (compared in normalized form),
 * each once.
 */
export function saveFailureMessages(
  reported: string[],
  thrown: unknown
): string[] {
  const failures =
    thrown instanceof SaveJobsError
      ? thrown.failures
      : thrown == null
        ? []
        : [thrown];
  const messages = [...reported];
  const seen = new Set(reported);
  for (const failure of failures) {
    const normalized = normalizeSqlError(failure);
    const raw = errorText(failure);
    if (seen.has(normalized) || seen.has(raw)) continue;
    messages.push(raw || normalized);
    seen.add(normalized);
    seen.add(raw);
  }
  return [...new Set(messages)].filter(Boolean);
}
