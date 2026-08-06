import { useMemo, useRef } from "preact/hooks";
import type { Dispatch, StateUpdater } from "preact/hooks";
import {
  chatReply,
  getAmbiguousPromptReply,
  getDirectMetadataReply,
  looksLikeMetadataQuestion,
  wantsSqlGeneration,
  isGeneralChatPrompt,
  planSqlFromQuestion,
  resolveReplyLanguage,
  saveLocalAiSettings,
  formatSqlExecutionError,
} from "src/lib/ai-assistant";
import type { ChatMessage, DatabaseEngine, TableItem } from "src/types";

export type AssistantStatus = "idle" | "loading_model" | "thinking";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatAssistantRequestError(args: {
  error: unknown;
  lang: ReturnType<typeof resolveReplyLanguage>;
}) {
  const raw =
    args.error instanceof Error ? args.error.message : String(args.error ?? "");
  const vi = args.lang.code === "vie";
  const isProviderRequest =
    raw.includes("AI_CHAT_REQUEST_FAILED") ||
    raw.includes("AI_PROVIDER") ||
    raw.includes("/chat/completions");

  if (!isProviderRequest) return null;

  const isLocalEndpoint =
    raw.includes("127.0.0.1") ||
    raw.includes("localhost") ||
    raw.includes(":11434");

  if (vi) {
    return isLocalEndpoint
      ? "Không kết nối được tới local AI provider. Hãy kiểm tra Ollama/local OpenAI-compatible server đã chạy chưa."
      : "Không kết nối được tới local AI provider. Hãy kiểm tra host, model hoặc local runtime trong AI settings.";
  }

  return isLocalEndpoint
    ? "I could not reach the local AI provider. Check that Ollama or your OpenAI-compatible local server is running."
    : "I could not reach the local AI provider. Check the host, model, or local runtime in AI settings.";
}

export function useAiAssistantSubmit(args: {
  prompt: string;
  setPrompt: Dispatch<StateUpdater<string>>;
  messages: ChatMessage[];
  appendUserMessage: (text: string) => void;
  appendAssistantMessage: (
    message: Omit<ChatMessage, "id" | "role">,
    startedAt?: number
  ) => void;
  beginStreamingAssistantMessage: () => string;
  updateStreamingAssistantText: (id: string, text: string) => void;
  finalizeStreamingAssistantMessage: (
    id: string,
    message: Omit<ChatMessage, "id" | "role" | "streaming">,
    startedAt?: number
  ) => void;
  clearStreamingMessages: () => void;
  setSubmitting: Dispatch<StateUpdater<boolean>>;
  setAssistantStatus: Dispatch<StateUpdater<AssistantStatus>>;
  providerId?: string;
  endpoint: string;
  model: string;
  engine: DatabaseEngine;
  workspaceId?: string;
  runtimeConnectionId?: string;
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  currentSql?: string;
}) {
  const {
    prompt,
    setPrompt,
    messages,
    appendUserMessage,
    appendAssistantMessage,
    beginStreamingAssistantMessage,
    updateStreamingAssistantText,
    finalizeStreamingAssistantMessage,
    clearStreamingMessages,
    setSubmitting,
    setAssistantStatus,
    providerId,
    endpoint,
    model,
    engine,
    activeSchema,
    tables,
    columnsByTable,
    currentSql,
  } = args;

  const requestAbortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  const canSubmit = useMemo(() => {
    return Boolean(prompt.trim() && endpoint.trim() && model.trim());
  }, [prompt, endpoint, model]);

  const handleCancelSubmit = () => {
    requestSeqRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    clearStreamingMessages();
    setAssistantStatus("idle");
    setSubmitting(false);
  };

  const handleSubmit = async () => {
    if (!canSubmit) return;

    requestSeqRef.current += 1;
    const requestId = requestSeqRef.current;
    const abortController = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = abortController;

    const question = prompt.trim();
    const requestStartedAt = Date.now();

    setPrompt("");
    setSubmitting(true);
    setAssistantStatus("thinking");
    saveLocalAiSettings({ endpoint, model });

    appendUserMessage(question);

    try {
      let intentKind: "chat" | "metadata" | "sql" | "clarify";

      if (isGeneralChatPrompt(question)) {
        intentKind = "chat";
      } else if (wantsSqlGeneration(question)) {
        intentKind = "sql";
      } else if (looksLikeMetadataQuestion(question)) {
        intentKind = "metadata";
      } else if (getAmbiguousPromptReply({ question, history: messages })) {
        intentKind = "clarify";
      } else {
        intentKind = "sql";
      }

      const onAssistantStatus = (status: "loading_model" | "generating") => {
        setAssistantStatus(
          status === "loading_model" ? "loading_model" : "thinking"
        );
      };

      if (intentKind === "chat") {
        const streamId = beginStreamingAssistantMessage();
        const reply = await chatReply({
          providerId,
          endpoint,
          model,
          engine,
          question,
          activeSchema,
          tables,
          history: messages,
          onStatusChange: onAssistantStatus,
          onDelta: (text) => {
            if (requestSeqRef.current !== requestId) return;
            updateStreamingAssistantText(streamId, text);
          },
          signal: abortController.signal,
        });

        if (requestSeqRef.current !== requestId) return;

        finalizeStreamingAssistantMessage(
          streamId,
          {
            text: [reply.answer, reply.followup].filter(Boolean).join("\n\n"),
          },
          requestStartedAt
        );
        return;
      }

      if (intentKind === "clarify") {
        const ambiguousReply = getAmbiguousPromptReply({
          question,
          history: messages,
        }) ?? {
          answer:
            "I need a clearer request before I decide whether to answer normally or generate a query.",
        };

        appendAssistantMessage(
          {
            text: [ambiguousReply.answer, ambiguousReply.followup]
              .filter(Boolean)
              .join("\n\n"),
          },
          requestStartedAt
        );
        return;
      }

      if (intentKind === "metadata") {
        const directReply = getDirectMetadataReply({
          engine,
          question,
          activeSchema,
          tables,
        });

        if (directReply) {
          appendAssistantMessage(
            {
              text: [directReply.answer, directReply.followup]
                .filter(Boolean)
                .join("\n\n"),
            },
            requestStartedAt
          );
          return;
        }

        const streamId = beginStreamingAssistantMessage();
        const reply = await chatReply({
          providerId,
          endpoint,
          model,
          engine,
          question: `The user asked: "${question}". Using only the visible tables/schemas in this connection, answer directly. Do not generate SQL.`,
          activeSchema,
          tables,
          history: messages,
          onStatusChange: onAssistantStatus,
          onDelta: (text) => {
            if (requestSeqRef.current !== requestId) return;
            updateStreamingAssistantText(streamId, text);
          },
          signal: abortController.signal,
        });

        if (requestSeqRef.current !== requestId) return;

        finalizeStreamingAssistantMessage(
          streamId,
          {
            text: [reply.answer, reply.followup].filter(Boolean).join("\n\n"),
          },
          requestStartedAt
        );
        return;
      }

      const streamId = beginStreamingAssistantMessage();
      const plan = await planSqlFromQuestion({
        providerId,
        endpoint,
        model,
        engine,
        question,
        activeSchema,
        tables,
        columnsByTable,
        currentSql,
        history: messages,
        onStatusChange: onAssistantStatus,
        onDelta: (text) => {
          if (requestSeqRef.current !== requestId) return;
          updateStreamingAssistantText(streamId, text);
        },
        signal: abortController.signal,
      });

      if (requestSeqRef.current !== requestId) return;

      if (plan.needsClarification && !plan.sql) {
        finalizeStreamingAssistantMessage(
          streamId,
          {
            text:
              plan.explanation ||
              "I need more information to answer accurately.",
            clarification: plan.clarification,
            assumptions: plan.assumptions,
          },
          requestStartedAt
        );
        return;
      }

      finalizeStreamingAssistantMessage(
        streamId,
        {
          text:
            plan.explanation ||
            "I prepared the SQL below. Review it before running.",
          sql: plan.sql || undefined,
          parts: [
            {
              type: "text",
              text:
                plan.explanation ||
                "I prepared the SQL below. Review it before running.",
            },
            ...(plan.sql
              ? [
                  {
                    type: "sqlPreview" as const,
                    sql: plan.sql,
                    safety: (plan.safety === "read_only"
                      ? "read_only"
                      : plan.safety === "mutating"
                        ? "mutating"
                        : "unknown") as "read_only" | "mutating" | "unknown",
                    confirmationState: "pending" as const,
                  },
                ]
              : []),
          ],
          assumptions: plan.assumptions,
          clarification: plan.needsClarification
            ? plan.clarification
            : undefined,
        },
        requestStartedAt
      );
    } catch (err) {
      if (isAbortError(err) || requestSeqRef.current !== requestId) {
        return;
      }
      clearStreamingMessages();
      const lang = resolveReplyLanguage(question, messages);
      const assistantError = formatAssistantRequestError({
        error: err,
        lang,
      });
      appendAssistantMessage(
        {
          text:
            assistantError ??
            formatSqlExecutionError({
              error: err,
              lang,
              tables,
              columnsByTable,
              activeSchema,
              engine,
            }),
        },
        requestStartedAt
      );
    } finally {
      if (requestSeqRef.current === requestId) {
        requestAbortRef.current = null;
        setAssistantStatus("idle");
        setSubmitting(false);
      }
    }
  };

  return {
    canSubmit,
    handleSubmit,
    handleCancelSubmit,
  };
}
