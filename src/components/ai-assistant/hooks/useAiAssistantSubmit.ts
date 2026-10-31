import { useCallback, useMemo, useRef } from "preact/hooks";
import { assertTabTarget } from "src/lib/tabs/assertTabTarget";
import { isTabTargetError } from "src/lib/tabs/assertTabTarget";
import type { Dispatch, StateUpdater } from "preact/hooks";
import {
  chatReply,
  buildAssistantContext,
  getDirectAppContextReply,
  hasConcreteDatabaseContext,
  planAssistantTurn,
  resolveReplyLanguage,
  formatSqlExecutionError,
} from "src/lib/ai-assistant";
import type {
  AiColumnMetadata,
  ChatMessage,
  DatabaseEngine,
  TableItem,
} from "src/types";
import type { SavedConnectionSummary } from "src/lib/ai-assistant/types";
import { aiChatCancel } from "src/lib/tauri/ai";
import { hasProAccessNow } from "src/stores/license";
import { getAssistantMode } from "src/lib/ai-assistant/assistantMode";
import { noteRuntimeError } from "src/lib/tauri/runtimeAdmission";
import {
  AI_DATA_ACCESS_REQUIRED,
  aiAgentDataAccessStatus,
} from "src/lib/tauri/aiAgent";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import {
  AGENT_ENGINES,
  AgentFallback,
  agentActivityLabel,
  agentAnswerParts,
  agentHistory,
  firstDataMessage,
  readData,
  withoutData,
  runAgentTurn,
} from "src/lib/ai-assistant/agent";

export type AssistantStatus = "idle" | "loading_model" | "thinking";

function isAbortError(error: unknown) {
  if (error instanceof DOMException && error.name === "AbortError") return true;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("AI_CHAT_CANCELED");
}

export function formatAssistantRequestError(args: {
  error: unknown;
  lang: ReturnType<typeof resolveReplyLanguage>;
  isLocalProvider: boolean;
}) {
  const raw =
    args.error instanceof Error ? args.error.message : String(args.error ?? "");
  const vi = args.lang.code === "vie";

  // The tab may not use this connection (plan tab-database-reconnect D3):
  // nothing was sent.
  if (isTabTargetError(args.error)) return args.error.message;

  // The connection's settings changed or it is unknown (plan
  // tab-database-reconnect R20): nothing was read.
  if (
    raw.includes("RUNTIME_STALE") ||
    raw.includes("RUNTIME_IDENTITY_MISSING")
  ) {
    return vi
      ? "Cấu hình kết nối đã thay đổi. Hãy kết nối lại tab này rồi hỏi lại."
      : "The connection settings changed. Reconnect this tab, then ask again.";
  }

  // AI agent data queries (plan ai-agent R5).
  if (raw.includes("AI_DATA_APPROVAL_DENIED")) {
    return vi
      ? "Bạn đã từ chối cho AI chạy truy vấn đọc dữ liệu. Hãy hỏi lại hoặc diễn đạt khác."
      : "You declined the AI's data query. Ask again or rephrase the question.";
  }
  if (raw.includes(AI_DATA_ACCESS_REQUIRED)) {
    return vi
      ? "AI cần quyền đọc dữ liệu của kết nối này để trả lời."
      : "The AI needs permission to read data from this connection to answer.";
  }

  // Ollama native agent wire and context size (plan ollama-native-context A9').
  // Fixed codes, matched before the generic agent and provider branches; provider
  // text that may follow a code is never shown.
  if (raw.includes("AI_AGENT_CONTEXT_FULL")) {
    return vi
      ? "Yêu cầu vượt quá context của model. Hãy tăng Context size trong AI settings, hoặc hỏi ngắn gọn hơn."
      : "The request did not fit the model's context. Increase Context size in AI settings, or ask a shorter question.";
  }
  if (raw.includes("AI_OLLAMA_UPDATE_REQUIRED")) {
    return vi
      ? "Cần cập nhật Ollama lên 0.12.6 trở lên để dùng AI agent."
      : "Update Ollama to 0.12.6 or newer to use the AI agent.";
  }
  if (raw.includes("AI_OLLAMA_MODEL_NOT_FOUND")) {
    return vi
      ? "Không tìm thấy model này trên server Ollama. Hãy tải model hoặc chọn model khác."
      : "This model was not found on the Ollama server. Pull it or choose another model.";
  }
  if (raw.includes("AI_OLLAMA_MODEL_INFO_UNAVAILABLE")) {
    return vi
      ? "Không đọc được kích thước context của model này nên AI agent chưa chạy được. Hãy kiểm tra model trên server Ollama."
      : "Couldn't read this model's context size, so the AI agent can't run. Check the model on the Ollama server.";
  }
  if (raw.includes("AI_OLLAMA_LOAD_FAILED")) {
    return vi
      ? "Ollama không đủ bộ nhớ để nạp model với context size này. Hãy giảm Context size trong AI settings."
      : "Ollama doesn't have enough memory to load the model at this context size. Lower Context size in AI settings.";
  }
  if (raw.includes("AI_PROVIDER_UNREACHABLE")) {
    return vi
      ? "Không kết nối được tới server AI. Hãy kiểm tra server đang chạy và URL trong AI settings."
      : "Couldn't reach the AI server. Check that it is running and the URL in AI settings.";
  }
  if (raw.includes("AI_PROVIDER_CONTEXT_SIZE_INVALID")) {
    return vi
      ? "Context size trong AI settings không hợp lệ (2048–262144)."
      : "The Context size in AI settings is invalid (2048–262144).";
  }

  // AI agent run limits and connection state (plan ai-agent R1).
  if (
    raw.includes("AI_AGENT_DEADLINE") ||
    raw.includes("AI_AGENT_BUDGET_EXHAUSTED") ||
    raw.includes("AI_AGENT_STEP_LIMIT")
  ) {
    return vi
      ? "AI agent không hoàn thành trong giới hạn cho phép. Hãy hỏi cụ thể hơn (ví dụ nêu tên bảng) rồi thử lại."
      : "The AI agent could not finish within its limits. Ask a more specific question (for example, name the table) and try again.";
  }
  if (raw.includes("CONNECTION_NOT_FOUND")) {
    return vi
      ? "Kết nối database đã đóng. Hãy kết nối lại rồi thử lại."
      : "The database connection was closed. Reconnect and try again.";
  }
  if (raw.includes("AI_AGENT_PRO_REQUIRED")) {
    return vi
      ? "Chế độ AI agent thuộc gói Pro. Hãy nâng cấp, hoặc hỏi lại khi chưa chọn kết nối database."
      : "AI agent mode is a Pro feature. Upgrade, or ask again without a database connection.";
  }
  if (raw.includes("AI_AGENT_")) {
    return vi
      ? "AI agent gặp lỗi. Hãy thử lại."
      : "The AI agent ran into a problem. Try again.";
  }
  const isProviderRequest =
    raw.includes("AI_CHAT_FAILED") ||
    raw.includes("AI_CHAT_EMPTY_RESPONSE") ||
    raw.includes("AI_CHAT_OUTPUT_TOKEN_LIMIT") ||
    raw.includes("AI_CHAT_REFUSED") ||
    raw.includes("AI_CHAT_REQUEST_FAILED") ||
    raw.includes("AI_PROVIDER");

  if (!isProviderRequest) return null;

  const isLocalEndpoint = args.isLocalProvider;

  if (raw.includes("AI_PROVIDER_NOT_CONFIGURED")) {
    return vi
      ? "Chưa có AI provider nào được bật. Hãy mở AI settings để thêm hoặc bật một provider."
      : "No AI provider is enabled. Open AI settings to add or enable one.";
  }

  if (raw.includes("AI_PROVIDER_DISABLED")) {
    return vi
      ? "AI provider này đang tắt. Hãy bật lại trong AI settings."
      : "This AI provider is disabled. Enable it in AI settings.";
  }

  if (
    raw.includes("AI_PROVIDER_URL_HOST_NOT_ALLOWED") ||
    raw.includes("AI_PROVIDER_URL_INVALID") ||
    raw.includes("AI_PROVIDER_HTTPS_REQUIRED")
  ) {
    return vi
      ? "URL của AI provider không được phép. Với http chỉ dùng localhost hoặc IP trong mạng LAN; các host khác cần https."
      : "This AI provider URL is not allowed. Plain http works only for localhost or LAN IP addresses; other hosts need https.";
  }

  if (
    /exceed(?:s|ed)? the available context size|exceed_context_size_error/i.test(
      raw
    )
  ) {
    return vi
      ? "Nội dung cuộc trò chuyện vượt giới hạn context của model local. PoliteDB đã rút gọn context; hãy thử gửi lại."
      : "This conversation exceeded the local model context limit. PoliteDB has reduced the context; try sending it again.";
  }

  if (raw.includes("AI_CHAT_REFUSED")) {
    return vi
      ? "Model từ chối trả lời yêu cầu này. Hãy diễn đạt lại hoặc chọn model khác."
      : "The model declined to answer this request. Rephrase it or choose another model.";
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
      ? "Không kết nối được tới local AI provider. Hãy kiểm tra Ollama đã chạy và URL trong AI settings đúng chưa."
      : "Không kết nối được tới AI provider. Hãy kiểm tra API key, host, hoặc model trong AI settings.";
  }

  return isLocalEndpoint
    ? "I could not reach the local AI provider. Check that Ollama is running and the URL in AI settings is correct."
    : "I could not reach the AI provider. Check the API key, host, or model in AI settings.";
}

export function useAiAssistantSubmit(args: {
  prompt: string;
  setPrompt: Dispatch<StateUpdater<string>>;
  messages: ChatMessage[];
  appendUserMessage: (text: string, extra?: { dataRead?: boolean }) => void;
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
  providerId: string;
  /** Whether the selected provider is a user-run local server (affects error wording). */
  isLocalProvider: boolean;
  model: string;
  engine: DatabaseEngine;
  runtimeConnectionId?: string;
  /** The connection tab the assistant works in (D3). */
  tabId?: string;
  /** The editor's safety mode: data queries need approval in safe/production. */
  querySafetyMode?: QuerySafetyMode;
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
  /** The agent would have answered this turn, but Pro features are locked. */
  onAgentProLocked?: () => void;
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
    isLocalProvider,
    model,
    engine,
    runtimeConnectionId,
    tabId,
    querySafetyMode,
    activeSchema,
    tables,
    columnsByTable,
    columnDetailsByTable,
    currentSql,
    activeTable,
    savedConnections,
    conversationState,
    updateConversationState,
    onAgentProLocked,
  } = args;

  const requestAbortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  const canSubmit = useMemo(() => {
    return Boolean(prompt.trim() && model.trim() && providerId.trim());
  }, [prompt, model, providerId]);

  const handleCancelSubmit = useCallback(() => {
    requestSeqRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    void aiChatCancel();
    clearStreamingMessages();
    setAssistantStatus("idle");
    setSubmitting(false);
  }, [clearStreamingMessages, setAssistantStatus, setSubmitting]);

  const handleSubmit = async () => {
    if (!canSubmit) return;
    await submit(prompt.trim(), true);
  };

  /** Asks `text` again without touching the prompt (after allowing data access). */
  const submitQuestion = async (text: string) => {
    if (!text.trim() || !model.trim() || !providerId.trim()) return;
    await submit(text.trim(), false);
  };

  const submit = async (question: string, fromPrompt: boolean) => {
    requestSeqRef.current += 1;
    const requestId = requestSeqRef.current;
    const abortController = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = abortController;

    const requestStartedAt = Date.now();

    if (fromPrompt) setPrompt("");
    setSubmitting(true);
    setAssistantStatus("thinking");

    // Once a chat holds database data, every later message counts as holding it too
    // (it may quote or summarise it), so the mark survives the original's eviction.
    const tainted = firstDataMessage(messages) >= 0;
    appendUserMessage(question, tainted ? { dataRead: true } : undefined);
    const finalize: typeof finalizeStreamingAssistantMessage = (
      id,
      message,
      startedAt
    ) =>
      finalizeStreamingAssistantMessage(
        id,
        tainted ? { ...message, dataRead: true } : message,
        startedAt
      );
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

      // Answers built from database data (and everything after them) go to a
      // provider only where the backend checks data-access consent right before the
      // request: the agent path. Every other path (direct replies, the legacy planner,
      // fallback after an agent attempt) never gets them (plan ai-agent R5).
      const historyHasData = tainted;
      const history = withoutData(messages);

      const onAssistantStatus = (_status: "generating") => {
        setAssistantStatus("thinking");
      };

      const directAppReply = getDirectAppContextReply({
        question,
        history,
        savedConnections,
      });
      if (directAppReply) {
        if (requestSeqRef.current !== requestId) return;
        finalize(
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

      // AI agent: inspects the schema with tools before answering. Any reason it
      // cannot run here (provider/model/engine unsupported) falls back silently.
      // It is a Pro feature: without Pro the turn goes to basic chat, like an
      // unsupported engine, and the panel shows an upgrade hint.
      // Manual mode always answers with basic chat; agent mode needs Pro.
      const agentEligible = Boolean(
        hasDbContext &&
        runtimeConnectionId &&
        AGENT_ENGINES.includes(engine) &&
        getAssistantMode() === "agent"
      );
      const agentAllowed = agentEligible && hasProAccessNow();
      if (agentEligible && !agentAllowed) onAgentProLocked?.();
      if (agentAllowed && runtimeConnectionId) {
        // D3: the agent reads only through the tab's own connection, on its
        // target; the refusal is the answer.
        assertTabTarget(tabId, runtimeConnectionId);
        try {
          const result = await runAgentTurn({
            providerId,
            model,
            question,
            connectionId: runtimeConnectionId,
            editorSql: currentSql,
            // Same conversation and context the legacy planner gets.
            // The backend checks consent before sending any of it.
            history: agentHistory(messages),
            historyHasData,
            activeSchema: activeSchema ?? null,
            activeTable: activeTable?.name ?? null,
            targetTable: conversationState.targetTable ?? null,
            replyLanguage: resolveReplyLanguage(question, messages).name,
            includeColumnDetails: true,
            safetyMode: querySafetyMode ?? null,
            signal: abortController.signal,
            onActivity: (tool) => {
              if (requestSeqRef.current !== requestId) return;
              updateStreamingAssistantText(streamId, agentActivityLabel(tool));
            },
          });
          if (requestSeqRef.current !== requestId) return;
          const answer = await agentAnswerParts(result, runtimeConnectionId);
          if (requestSeqRef.current !== requestId) return;
          finalize(
            streamId,
            readData(result.steps) ? { ...answer, dataRead: true } : answer,
            requestStartedAt
          );
          return;
        } catch (agentError) {
          // A run ended because its connection went stale (its profile was
          // saved again or removed): the tab shows the reconnect message.
          noteRuntimeError(runtimeConnectionId, agentError);
          const code =
            agentError instanceof Error
              ? agentError.message
              : String(agentError);
          if (code.includes(AI_DATA_ACCESS_REQUIRED)) {
            // Nothing was sent: ask the user, then ask the question again.
            const status = await aiAgentDataAccessStatus(
              runtimeConnectionId,
              providerId
            ).catch(() => null);
            if (requestSeqRef.current !== requestId) return;
            const label = status?.label ?? undefined;
            const vi = resolveReplyLanguage(question, messages).code === "vie";
            const text = vi
              ? `Để trả lời, AI cần đọc dữ liệu từ ${label ?? "kết nối này"}.`
              : `To answer, the AI needs to read data from ${label ?? "this connection"}.`;
            finalize(
              streamId,
              {
                text,
                parts: [
                  { type: "text", text },
                  {
                    type: "dataAccessRequest",
                    question,
                    label,
                    state: "pending",
                  },
                ],
              },
              requestStartedAt
            );
            return;
          }
          if (!(agentError instanceof AgentFallback)) throw agentError;
        }
      }

      if (!hasDbContext) {
        const reply = await chatReply({
          providerId,
          model,
          engine,
          question,
          activeSchema,
          tables,
          columnsByTable,
          activeTable,
          savedConnections,
          history,
          onStatusChange: onAssistantStatus,
          onDelta: (text) => {
            if (requestSeqRef.current !== requestId) return;
            updateStreamingAssistantText(streamId, text);
          },
          signal: abortController.signal,
        });

        if (requestSeqRef.current !== requestId) return;

        finalize(
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
        history,
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
        finalize(
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

      finalize(
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
        isLocalProvider,
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
    submitQuestion,
    handleCancelSubmit,
  };
}
