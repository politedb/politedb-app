import { Channel } from "@tauri-apps/api/core";
import { invoke } from "./runtimeInvoke";
import { CMD } from "./commands";

/** Events streamed by a backend agent run (`ai::agent::run::AgentEvent`). */
export type AiAgentEvent =
  | { type: "step"; n: number }
  | { type: "toolStarted"; tool: string }
  | {
      type: "toolFinished";
      tool: string;
      ok: boolean;
      truncated: boolean;
      durationMs: number;
    }
  | { type: "answer"; text: string }
  | {
      type: "done";
      status: "answered" | "failed" | "canceled";
      steps: number;
      inputTokens: number;
      outputTokens: number;
    }
  | { type: "error"; code: string };

export type AiAgentStartInput = {
  /** Client-generated id (letters, digits, `-`, `_`; ≤ 64) used to cancel the run. */
  runId: string;
  providerId: string;
  model?: string | null;
  question: string;
  /** Runtime connection whose catalog the agent may read (Phase 2 metadata tools). */
  connectionId?: string | null;
  /** Editor SQL, only when the user's "sql" context chip is on. */
  editorSql?: string | null;
  /** Visible earlier messages of this chat (the backend bounds them again). */
  history?: AiAgentHistoryEntry[];
  activeSchema?: string | null;
  activeTable?: string | null;
  /** The table earlier answers were about. */
  targetTable?: string | null;
  /** Language name the answer should use, e.g. "Vietnamese". */
  replyLanguage?: string | null;
  /** Send column comments and defaults to the provider (setting, on by default). */
  includeColumnDetails?: boolean;
  /**
   * The editor's query safety mode. Data queries need native approval in
   * `safe`/`production` and are off in `lock` (the backend treats missing as `lock`).
   */
  safetyMode?: string | null;
  /**
   * The history holds answers built from this connection's data: the backend sends
   * nothing unless data-access consent holds for this provider.
   */
  historyHasData?: boolean;
};

export type AiAgentHistoryEntry = { role: "user" | "assistant"; text: string };

/**
 * Former agent settings: the "AI agent (beta)" opt-in and the column-details opt-out.
 * The agent is always on and always sends column details now; the keys are only cleared.
 */
export const LEGACY_AI_AGENT_KEYS = [
  "politedb.ai.agent.enabled",
  "politedb.ai.agent.columnDetails",
];

function forgetLegacyAgentSettings(): void {
  try {
    for (const key of LEGACY_AI_AGENT_KEYS) localStorage.removeItem(key);
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

/**
 * Starts an agent run; resolves once it started (progress arrives on `onEvent`).
 * Rejects up front with `AI_AGENT_PROVIDER_UNSUPPORTED` / `AI_AGENT_TOOLS_UNSUPPORTED`
 * when the legacy assistant should be used instead.
 */
export async function aiAgentStart(
  input: AiAgentStartInput,
  onEvent: (event: AiAgentEvent) => void
): Promise<void> {
  forgetLegacyAgentSettings();
  const channel = new Channel<AiAgentEvent>();
  channel.onmessage = onEvent;
  await invoke(CMD.aiAgentStart, { input, onEvent: channel });
}

/** Cancels a run; safe before it started or after it finished. */
export async function aiAgentCancel(runId: string): Promise<void> {
  await invoke(CMD.aiAgentCancel, { runId });
}

/**
 * Backend read-only check for suggested SQL on one runtime connection
 * (`ai_agent_sql_safety`): "read_only" only for a single plain query whose calls can
 * only reach built-ins there, else "unknown". Errors count as "unknown".
 */
export async function aiAgentSqlSafety(
  sql: string,
  connectionId: string
): Promise<"read_only" | "unknown"> {
  try {
    const result = await invoke<string>(CMD.aiAgentSqlSafety, {
      sql,
      connectionId,
    });
    return result === "read_only" ? "read_only" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Code of a run stopped because data access was not (or no longer) allowed. */
export const AI_DATA_ACCESS_REQUIRED = "AI_DATA_ACCESS_REQUIRED";

export type AiDataAccessStatus = {
  /** Data tools exist for this connection (engine, saved profile, file database). */
  available: boolean;
  granted: boolean;
  label: string | null;
};

export async function aiAgentDataAccessStatus(
  connectionId: string,
  providerId: string
): Promise<AiDataAccessStatus> {
  return invoke<AiDataAccessStatus>(CMD.aiAgentDataAccessStatus, {
    connectionId,
    providerId,
  });
}

/** Records the user's "Allow" for this connection's saved profile and provider. */
export async function aiAgentDataAccessGrant(
  connectionId: string,
  providerId: string
): Promise<void> {
  await invoke(CMD.aiAgentDataAccessGrant, { connectionId, providerId });
}

export type AiDataAccessGrant = {
  profileId: string;
  profileLabel: string | null;
  providerLabel: string | null;
  endpointHost: string;
  grantedAt: number;
};

export async function aiAgentDataAccessList(): Promise<AiDataAccessGrant[]> {
  return invoke<AiDataAccessGrant[]>(CMD.aiAgentDataAccessList);
}

/** Revokes a profile's grants and stops agent runs reading its connections. */
export async function aiAgentDataAccessRevoke(
  profileId: string
): Promise<void> {
  await invoke(CMD.aiAgentDataAccessRevoke, { profileId });
}
