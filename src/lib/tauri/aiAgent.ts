import { Channel, invoke } from "@tauri-apps/api/core";
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
};

export type AiAgentHistoryEntry = { role: "user" | "assistant"; text: string };

/** Opt-in for the agent (plan ai-agent R7): "AI agent (beta)" in AI settings, off by default. */
export const AI_AGENT_ENABLED_KEY = "politedb.ai.agent.enabled";

/** Shown in AI settings as "AI agent (beta)". */
export function setAiAgentEnabled(enabled: boolean): void {
  try {
    if (enabled) localStorage.setItem(AI_AGENT_ENABLED_KEY, "1");
    else localStorage.removeItem(AI_AGENT_ENABLED_KEY);
  } catch {
    // Storage unavailable: the agent simply stays off.
  }
}

/** Column comments and default values in agent metadata; on unless turned off. */
export const AI_AGENT_COLUMN_DETAILS_KEY = "politedb.ai.agent.columnDetails";

export function setAiAgentColumnDetails(include: boolean): void {
  try {
    if (include) localStorage.removeItem(AI_AGENT_COLUMN_DETAILS_KEY);
    else localStorage.setItem(AI_AGENT_COLUMN_DETAILS_KEY, "0");
  } catch {
    // Storage unavailable: the default applies.
  }
}

export function isAiAgentColumnDetailsEnabled(): boolean {
  try {
    return localStorage.getItem(AI_AGENT_COLUMN_DETAILS_KEY) !== "0";
  } catch {
    // Without storage, keep comments and defaults out.
    return false;
  }
}

export function isAiAgentEnabled(): boolean {
  try {
    return localStorage.getItem(AI_AGENT_ENABLED_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * Starts an agent run; resolves once it started (progress arrives on `onEvent`).
 * Rejects with `AI_AGENT_DISABLED` while the hidden setting is off, and up front with
 * `AI_AGENT_PROVIDER_UNSUPPORTED` / `AI_AGENT_TOOLS_UNSUPPORTED` when the legacy
 * assistant should be used instead.
 */
export async function aiAgentStart(
  input: AiAgentStartInput,
  onEvent: (event: AiAgentEvent) => void
): Promise<void> {
  if (!isAiAgentEnabled()) throw new Error("AI_AGENT_DISABLED");
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
