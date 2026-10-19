/**
 * How the assistant answers when a database connection is open:
 * - `agent`: looks up the schema and runs read-only queries itself (Pro).
 * - `manual`: chat only, from the conversation and the context the user attaches.
 *
 * One session value is authoritative for the picker, the panel and submission. It starts
 * from the device's stored choice (default agent); saving it is best effort, so a failed
 * write never makes the next turn use a mode other than the one shown.
 */
export type AssistantMode = "agent" | "manual";

export const ASSISTANT_MODE_KEY = "politedb.ai.mode";

function readStoredMode(): AssistantMode {
  try {
    return localStorage.getItem(ASSISTANT_MODE_KEY) === "manual"
      ? "manual"
      : "agent";
  } catch {
    return "agent";
  }
}

let current: AssistantMode | null = null;
const listeners = new Set<(mode: AssistantMode) => void>();

export function getAssistantMode(): AssistantMode {
  if (current === null) current = readStoredMode();
  return current;
}

export function setAssistantMode(mode: AssistantMode) {
  current = mode;
  try {
    localStorage.setItem(ASSISTANT_MODE_KEY, mode);
  } catch {
    // Storage unavailable: the choice still holds for this session.
  }
  for (const listener of listeners) listener(mode);
}

/** Calls `listener` on every mode change; returns the unsubscribe function. */
export function subscribeAssistantMode(
  listener: (mode: AssistantMode) => void
) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Tests only: forget the session value so the next read uses storage again. */
export function resetAssistantModeForTests() {
  current = null;
}
