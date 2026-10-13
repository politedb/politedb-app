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
};

/**
 * Hidden opt-in for the agent (plan ai-agent R7, Phase 1). No UI reads or sets it yet;
 * Phase 2 surfaces it as "AI agent (beta)", off by default. Enable manually with
 * `localStorage.setItem("politedb.ai.agent.enabled", "1")`.
 */
export const AI_AGENT_ENABLED_KEY = "politedb.ai.agent.enabled";

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
