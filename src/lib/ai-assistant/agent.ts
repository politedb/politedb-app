import {
  aiAgentCancel,
  aiAgentSqlSafety,
  aiAgentStart,
  type AiAgentEvent,
  type AiAgentHistoryEntry,
} from "src/lib/tauri/aiAgent";
import { isDDLStatement, isMutatingStatement } from "src/lib/sql/detect";
import type { AgentStepSummary, ChatMessage, ChatMessagePart } from "src/types";
import { isReadOnlySql } from "./index";

/** Engines with agent metadata tools in v1 (backend `ai::agent::catalog`). */
export const AGENT_ENGINES = ["postgres", "mysql", "mariadb", "sqlite"];

/**
 * Codes meaning "use the legacy assistant instead": the agent is off, or this
 * provider, model or engine cannot run it. Only valid before any tool ran.
 */
const FALLBACK_CODES = [
  "AI_AGENT_DISABLED",
  "AI_AGENT_PROVIDER_UNSUPPORTED",
  "AI_AGENT_TOOLS_UNSUPPORTED",
  "AI_AGENT_ENGINE_UNSUPPORTED",
];

export class AgentFallback extends Error {
  constructor(code: string) {
    super(code);
    this.name = "AgentFallback";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function abortError(): Error {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

export type AgentTurnResult = { text: string; steps: AgentStepSummary[] };

/** Tools whose results contain database data. */
export const DATA_TOOLS = [
  "sample_rows",
  "run_readonly_query",
  "explain_query",
];

/**
 * Whether an agent run queried data: any data tool call counts, failed ones too (a
 * database error can quote values).
 */
export function readData(steps: AgentStepSummary[]): boolean {
  return steps.some((step) => DATA_TOOLS.includes(step.tool));
}

/** Index of the first message built from database data, or -1. */
export function firstDataMessage(messages: ChatMessage[]): number {
  return messages.findIndex((message) => message.dataRead);
}

/**
 * The history without anything from the first data answer on (later answers may
 * summarise it), for when data-access consent does not hold.
 */
export function withoutData(messages: ChatMessage[]): ChatMessage[] {
  const first = firstDataMessage(messages);
  return first < 0 ? messages : messages.slice(0, first);
}

/** Earlier messages sent with a question (the backend applies its own byte caps). */
export const AGENT_HISTORY_MESSAGES = 12;

/**
 * The visible part of earlier messages: text plus any SQL shown, never step details,
 * result rows or provider state.
 */
export function agentHistory(messages: ChatMessage[]): AiAgentHistoryEntry[] {
  return messages
    .filter((message) => !message.streaming)
    .slice(-AGENT_HISTORY_MESSAGES)
    .map((message) => {
      const sql =
        message.sql ??
        message.parts?.find((part) => part.type === "sqlPreview")?.sql;
      const text =
        sql && !message.text.includes(sql)
          ? `${message.text}\n\n\`\`\`sql\n${sql}\n\`\`\``
          : message.text;
      return { role: message.role, text: text.trim() };
    })
    .filter((entry) => entry.text.length > 0);
}

/**
 * Runs one agent turn in the backend and resolves with its answer. Rejects with
 * {@link AgentFallback} when the legacy assistant should answer instead, with an
 * AbortError when `signal` aborts (the backend run is cancelled too), or with the
 * run's error code.
 */
export function runAgentTurn(opts: {
  providerId: string;
  model?: string | null;
  question: string;
  connectionId: string;
  editorSql?: string | null;
  history?: AiAgentHistoryEntry[];
  activeSchema?: string | null;
  activeTable?: string | null;
  targetTable?: string | null;
  replyLanguage?: string | null;
  includeColumnDetails?: boolean;
  safetyMode?: string | null;
  historyHasData?: boolean;
  signal?: AbortSignal;
  onSteps?: (steps: AgentStepSummary[]) => void;
}): Promise<AgentTurnResult> {
  const runId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const steps: AgentStepSummary[] = [];
    let answer = "";
    let errorCode = "";
    let toolRan = false;
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    const onAbort = () => {
      void aiAgentCancel(runId).catch(() => {});
      settle(() => reject(abortError()));
    };
    if (opts.signal?.aborted) {
      reject(abortError());
      return;
    }
    opts.signal?.addEventListener("abort", onAbort);

    const onEvent = (event: AiAgentEvent) => {
      switch (event.type) {
        case "toolStarted":
          toolRan = true;
          break;
        case "toolFinished":
          steps.push({
            tool: event.tool,
            ok: event.ok,
            truncated: event.truncated,
            durationMs: event.durationMs,
          });
          opts.onSteps?.([...steps]);
          break;
        case "answer":
          answer = event.text;
          break;
        case "error":
          errorCode = event.code;
          break;
        case "done":
          settle(() => {
            if (event.status === "answered") {
              resolve({ text: answer, steps });
            } else if (event.status === "canceled") {
              reject(abortError());
            } else if (!toolRan && FALLBACK_CODES.includes(errorCode)) {
              reject(new AgentFallback(errorCode));
            } else {
              reject(new Error(errorCode || "AI_AGENT_FAILED"));
            }
          });
          break;
      }
    };

    aiAgentStart(
      {
        runId,
        providerId: opts.providerId,
        model: opts.model ?? null,
        question: opts.question,
        connectionId: opts.connectionId,
        editorSql: opts.editorSql ?? null,
        history: opts.history ?? [],
        activeSchema: opts.activeSchema ?? null,
        activeTable: opts.activeTable ?? null,
        targetTable: opts.targetTable ?? null,
        replyLanguage: opts.replyLanguage ?? null,
        includeColumnDetails: opts.includeColumnDetails ?? false,
        safetyMode: opts.safetyMode ?? null,
        historyHasData: opts.historyHasData ?? false,
      },
      onEvent
    ).catch((error) => {
      const code = errorText(error);
      settle(() =>
        reject(
          FALLBACK_CODES.some((c) => code.includes(c))
            ? new AgentFallback(code)
            : error
        )
      );
    });
  });
}

const SQL_BLOCK = /```sql\s*\n([\s\S]*?)```/i;

/**
 * Safety computed locally from the SQL, never taken from the model (plan R7).
 * "read_only" (which offers Run) needs both the frontend heuristic and the backend
 * check to agree; everything else only offers Insert.
 */
export async function sqlSafety(
  sql: string,
  connectionId: string
): Promise<"read_only" | "mutating" | "ddl" | "unknown"> {
  if (
    isReadOnlySql(sql) &&
    (await aiAgentSqlSafety(sql, connectionId)) === "read_only"
  )
    return "read_only";
  if (isDDLStatement(sql)) return "ddl";
  if (isMutatingStatement(sql)) return "mutating";
  return "unknown";
}

/**
 * Message parts for an agent answer: what it looked at, the text, and the first
 * ```sql block as a SQL preview (Run only if locally judged read-only).
 */
export async function agentAnswerParts(
  result: AgentTurnResult,
  connectionId: string
): Promise<{
  text: string;
  sql?: string;
  parts: ChatMessagePart[];
}> {
  const match = SQL_BLOCK.exec(result.text);
  const sql = match?.[1]?.trim();
  const text = (sql ? result.text.replace(match![0], "") : result.text).trim();
  const parts: ChatMessagePart[] = [];
  if (result.steps.length)
    parts.push({ type: "agentSteps", steps: result.steps });
  if (text) parts.push({ type: "text", text });
  if (sql) {
    parts.push({
      type: "sqlPreview",
      sql,
      safety: await sqlSafety(sql, connectionId),
      agent: true,
      confirmationState: "pending",
    });
  }
  return { text: text || result.text, sql, parts };
}
