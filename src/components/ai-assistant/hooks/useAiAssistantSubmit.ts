import { useCallback, useMemo, useRef } from "preact/hooks";
import type { Dispatch, StateUpdater } from "preact/hooks";
import {
  chatReply,
  buildAssistantContext,
  getDirectAppContextReply,
  hasConcreteDatabaseContext,
  planAssistantTurn,
  resolveReplyLanguage,
  saveLocalAiSettings,
  formatSqlExecutionError,
} from "src/lib/ai-assistant";
import type {
  AiColumnMetadata,
  ChatMessage,
  DatabaseEngine,
  TableItem,
} from "src/types";
import type { SavedConnectionSummary } from "src/lib/ai-assistant/types";
import { DEFAULT_LOCAL_AI_PROVIDER_ID } from "src/lib/ai-assistant/providers";

export type AssistantStatus = "idle" | "loading_model" | "thinking";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function formatAssistantRequestError(args: {
  error: unknown;
  lang: ReturnType<typeof resolveReplyLanguage>;
  endpoint?: string;
  providerId?: string;
}) {
  const raw =
    args.error instanceof Error ? args.error.message : String(args.error ?? "");
  const vi = args.lang.code === "vie";
  const isProviderRequest =
    raw.includes("AI_CHAT_FAILED") ||
    raw.includes("AI_CHAT_EMPTY_RESPONSE") ||
    raw.includes("AI_CHAT_OUTPUT_TOKEN_LIMIT") ||
    raw.includes("AI_CHAT_REQUEST_FAILED") ||
    raw.includes("AI_PROVIDER") ||
    raw.includes("OLLAMA_GENERATE_FAILED") ||
    raw.includes("/chat/completions");

  if (!isProviderRequest) return null;

  const endpoint = (args.endpoint ?? "").toLowerCase();
  const isLocalEndpoint =
    args.providerId === DEFAULT_LOCAL_AI_PROVIDER_ID ||
    endpoint.includes("127.0.0.1") ||
    endpoint.includes("localhost") ||
    endpoint.includes(":11434") ||
    raw.includes("127.0.0.1") ||
    raw.includes("localhost") ||
    raw.includes(":11434");

  if (
    /exceed(?:s|ed)? the available context size|exceed_context_size_error/i.test(
      raw
    )
  ) {
    return vi
      ? "Nội dung cuộc trò chuyện vượt giới hạn context của model local. PoliteDB đã rút gọn context; hãy thử gửi lại."
      : "This conversation exceeded the local model context limit. PoliteDB has reduced the context; try sending it again.";
  }

  if (
    raw.includes("AI_CHAT_EMPTY_RESPONSE") ||
    raw.includes("AI_CHAT_OUTPUT_TOKEN_LIMIT")
  ) {
    return vi
      ? "Model không tạo được nội dung trả lời. Hãy thử lại hoặc chọn model khác."
      : "The model did not produce a final response. Try again or choose another model.";
  }

  if (vi) {
    return isLocalEndpoint
      ? "Không kết nối được tới local AI provider. Hãy kiểm tra Ollama/local OpenAI-compatible server đã chạy chưa."
      : "Không kết nối được tới AI provider. Hãy kiểm tra API key, host, hoặc model trong AI settings.";
  }

  return isLocalEndpoint
    ? "I could not reach the local AI provider. Check that Ollama or your OpenAI-compatible local server is running."
    : "I could not reach the AI provider. Check the API key, host, or model in AI settings.";
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
  runtimeConnectionId?: string;
  activeSchema?: string;
  activeTable?: TableItem;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  columnDetailsByTable?: Record<string, AiColumnMetadata[]>;
  currentSql?: string;
  savedConnections?: SavedConnectionSummary[];
  conversationState: {
    replyLanguageCode?: string | null;
    targetTable?: string | null;
  };
  updateConversationState: (patch: {
    replyLanguageCode?: string | null;
    targetTable?: string | null;
  }) => void;
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
    runtimeConnectionId,
    activeSchema,
    tables,
    columnsByTable,
    columnDetailsByTable,
    currentSql,
    activeTable,
    savedConnections,
    conversationState,
    updateConversationState,
  } = args;

  const requestAbortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  const canSubmit = useMemo(() => {
    return Boolean(
      prompt.trim() && model.trim() && (providerId?.trim() || endpoint.trim())
    );
  }, [prompt, endpoint, model, providerId]);

  const handleCancelSubmit = useCallback(() => {
    requestSeqRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    clearStreamingMessages();
    setAssistantStatus("idle");
    setSubmitting(false);
  }, [clearStreamingMessages, setAssistantStatus, setSubmitting]);

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
    if (!conversationState.replyLanguageCode) {
      updateConversationState({
        replyLanguageCode: resolveReplyLanguage(question, messages).code,
      });
    }
    const streamId = beginStreamingAssistantMessage();

    try {
      const assistantContext = buildAssistantContext({
        engine,
        runtimeConnectionId,
        activeSchema,
        activeTable,
        tables,
        currentSql,
      });
      const hasDbContext = hasConcreteDatabaseContext(assistantContext);

      const onAssistantStatus = (status: "loading_model" | "generating") => {
        setAssistantStatus(
          status === "loading_model" ? "loading_model" : "thinking"
        );
      };

      const directAppReply = getDirectAppContextReply({
        question,
        history: messages,
        savedConnections,
      });
      if (directAppReply) {
        if (requestSeqRef.current !== requestId) return;
        finalizeStreamingAssistantMessage(
          streamId,
          {
            text: [directAppReply.answer, directAppReply.followup]
              .filter(Boolean)
              .join("\n\n"),
          },
          requestStartedAt
        );
        return;
      }

      if (!hasDbContext) {
        const reply = await chatReply({
          providerId,
          endpoint,
          model,
          engine,
          question,
          activeSchema,
          tables,
          columnsByTable,
          activeTable,
          savedConnections,
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

      const plan = await planAssistantTurn({
        providerId,
        endpoint,
        model,
        engine,
        question,
        activeSchema,
        activeTable,
        tables,
        columnsByTable,
        columnDetailsByTable,
        currentSql,
        targetTable: conversationState.targetTable ?? undefined,
        replyLanguageCode: conversationState.replyLanguageCode ?? undefined,
        savedConnections,
        history: messages,
        onStatusChange: onAssistantStatus,
        onDelta: (text) => {
          if (requestSeqRef.current !== requestId) return;
          updateStreamingAssistantText(streamId, text);
        },
        signal: abortController.signal,
      });

      if (requestSeqRef.current !== requestId) return;

      if (plan.targetTable) {
        updateConversationState({ targetTable: plan.targetTable });
      }

      if (plan.kind !== "sql" || !plan.sql) {
        finalizeStreamingAssistantMessage(
          streamId,
          {
            text:
              plan.answer ||
              plan.clarification ||
              (resolveReplyLanguage(question, messages).code === "vie"
                ? "Tôi cần thêm thông tin để trả lời chính xác."
                : "I need more information to answer accurately."),
            clarification: plan.clarification || undefined,
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
            plan.answer ||
            plan.explanation ||
            (resolveReplyLanguage(question, messages).code === "vie"
              ? "Tôi đã chuẩn bị SQL bên dưới. Hãy kiểm tra trước khi chạy."
              : "I prepared the SQL below. Review it before running."),
          sql: plan.sql || undefined,
          parts: [
            {
              type: "text",
              text:
                plan.answer ||
                plan.explanation ||
                (resolveReplyLanguage(question, messages).code === "vie"
                  ? "Tôi đã chuẩn bị SQL bên dưới. Hãy kiểm tra trước khi chạy."
                  : "I prepared the SQL below. Review it before running."),
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
        endpoint,
        providerId,
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
