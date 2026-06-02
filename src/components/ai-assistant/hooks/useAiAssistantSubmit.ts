import { useMemo, useRef } from "preact/hooks";
import type { Dispatch, StateUpdater } from "preact/hooks";
import {
  answerFromResult,
  buildFastResultAnswer,
  chatReply,
  getFastChatReply,
  getFastSqlReply,
  getAmbiguousPromptReply,
  getDirectMetadataReply,
  looksLikeMetadataQuestion,
  wantsSqlGeneration,
  isGeneralChatPrompt,
  isReadOnlySql,
  planSqlFromQuestion,
  queryResultToObjects,
  resolveReplyLanguage,
  saveLocalAiSettings,
  formatSqlExecutionError,
  formatSqlValidationIssues,
  validateSqlAgainstMetadata,
} from "src/lib/ai-assistant";
import { runSqlQuery } from "src/lib/tauri/query";
import type { ChatMessage, DatabaseEngine, TableItem } from "src/types";
import { sleep } from "src/utils/common";

export type AssistantStatus = "idle" | "loading_model" | "thinking";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
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
  endpoint: string;
  model: string;
  engine: DatabaseEngine;
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
    endpoint,
    model,
    engine,
    runtimeConnectionId,
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
      const fastChatReply = getFastChatReply(question);
      if (fastChatReply) {
        await sleep(500);
        appendAssistantMessage(
          {
            text: [fastChatReply.answer, fastChatReply.followup]
              .filter(Boolean)
              .join("\n\n"),
          },
          requestStartedAt
        );
        return;
      }

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
        await sleep(500);
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
          await sleep(500);
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

      const fastSql = getFastSqlReply({
        engine,
        question,
        activeSchema,
        tables,
      });
      if (fastSql) {
        await sleep(300);
        appendAssistantMessage(
          {
            text: fastSql.explanation,
            sql: fastSql.sql,
          },
          requestStartedAt
        );
        return;
      }

      const streamId = beginStreamingAssistantMessage();
      const plan = await planSqlFromQuestion({
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

      if (runtimeConnectionId && plan.sql && isReadOnlySql(plan.sql)) {
        const replyLang = resolveReplyLanguage(question, messages);
        const metadataValidation = validateSqlAgainstMetadata({
          sql: plan.sql,
          tables,
          columnsByTable,
          activeSchema,
        });

        if (!metadataValidation.ok) {
          finalizeStreamingAssistantMessage(
            streamId,
            {
              text: formatSqlValidationIssues(
                metadataValidation.issues,
                replyLang
              ),
              sql: plan.sql,
              assumptions: plan.assumptions,
              clarification: plan.clarification,
            },
            requestStartedAt
          );
          return;
        }

        let result;
        try {
          result = await runSqlQuery(runtimeConnectionId, plan.sql, {
            maxRows: 200,
            batchSize: 200,
            timeoutMs: 45_000,
          });
        } catch (queryErr) {
          if (requestSeqRef.current !== requestId) return;
          finalizeStreamingAssistantMessage(
            streamId,
            {
              text: formatSqlExecutionError({
                error: queryErr,
                lang: replyLang,
                sql: plan.sql,
                tables,
                columnsByTable,
                activeSchema,
                engine,
              }),
              sql: plan.sql,
              assumptions: plan.assumptions,
            },
            requestStartedAt
          );
          return;
        }

        if (requestSeqRef.current !== requestId) return;

        const preview = queryResultToObjects(result, 20);
        const fastAnswer = buildFastResultAnswer({
          result,
          preview,
          language: resolveReplyLanguage(question, messages),
        });

        let answer: {
          answer: string;
          confidence: "high" | "medium" | "low";
        } | null = fastAnswer
          ? {
              answer: fastAnswer.answer,
              confidence: fastAnswer.confidence,
            }
          : null;

        const shouldUseLlmSummary =
          !fastAnswer ||
          (preview.length > 0 &&
            preview.length <= 3 &&
            (result.columns ?? []).length <= 6 &&
            Number(result.rowCount ?? preview.length) <= 3);

        if (shouldUseLlmSummary) {
          answer = await answerFromResult({
            endpoint,
            model,
            engine,
            question,
            sql: plan.sql,
            result,
            history: messages,
            onStatusChange: onAssistantStatus,
            onDelta: (text) => {
              if (requestSeqRef.current !== requestId) return;
              updateStreamingAssistantText(streamId, text);
            },
            signal: abortController.signal,
          });
        }

        if (requestSeqRef.current !== requestId) return;

        finalizeStreamingAssistantMessage(
          streamId,
          {
            text:
              answer?.answer ||
              plan.explanation ||
              "I have run the query and got the result.",
            sql: plan.sql,
            assumptions: plan.assumptions,
            clarification: plan.needsClarification
              ? plan.clarification
              : undefined,
            resultPreview: preview,
            rowCount: Number(result.rowCount ?? preview.length),
            confidence: answer?.confidence,
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
            "I haven't run the query yet, but here is the SQL that matches your request.",
          sql: plan.sql || undefined,
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
      appendAssistantMessage(
        {
          text: formatSqlExecutionError({
            error: err,
            lang: resolveReplyLanguage(question, messages),
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
