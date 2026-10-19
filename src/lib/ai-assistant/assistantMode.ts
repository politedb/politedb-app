/**
 * How the assistant answers when a database connection is open:
 * - `agent`: looks up the schema and runs read-only queries itself (Pro).
 * - `manual`: chat only, from the conversation and the context the user attaches.
 * Stored per device; agent is the default.
 */
export type AssistantMode = "agent" | "manual";

export const ASSISTANT_MODE_KEY = "politedb.ai.mode";

export function getAssistantMode(): AssistantMode {
  try {
    return localStorage.getItem(ASSISTANT_MODE_KEY) === "manual"
      ? "manual"
      : "agent";
  } catch {
    return "agent";
  }
}

export function setAssistantMode(mode: AssistantMode) {
  try {
    localStorage.setItem(ASSISTANT_MODE_KEY, mode);
  } catch {
    // Storage unavailable: the choice lasts for this session only.
  }
}
