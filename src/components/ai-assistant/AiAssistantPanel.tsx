import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { AiAssistantMessageCard } from "src/components/ai-assistant/AiAssistantMessageCard";
import { AiAssistantSettingsPopover } from "src/components/ai-assistant/AiAssistantSettingsPopover";
import { Button } from "src/components/common/Button";
import { Popover } from "src/components/common/Popover";
import { ArrowDown, Settings } from "src/components/icons";
import {
  answerFromResult,
  chatReply,
  getLocalAiSettings,
  isGeneralChatPrompt,
  isReadOnlySql,
  listLocalAiModels,
  planSqlFromQuestion,
  queryResultToObjects,
  saveLocalAiSettings,
} from "src/lib/ai/localAssistant";
import {
  aiRuntimeStart,
  aiRuntimeStatus,
  aiRuntimeStop,
  type AiRuntimeStatus,
} from "src/lib/tauri";
import { runSqlQuery } from "src/lib/tauri/query";
import type { ChatMessage, DatabaseEngine, TableItem } from "src/types";
import { cn } from "src/utils/cn";

type Props = {
  engine: DatabaseEngine;
  runtimeConnectionId?: string;
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  currentSql?: string;
  onInsertSql?: (sql: string) => Promise<void> | void;
};

function formatError(error: unknown) {
  return error instanceof Error
    ? error.message
    : String(error ?? "Unknown error");
}

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function isBundledModelPlaceholder(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  return (
    normalized === "default" ||
    normalized === "default.gguf" ||
    normalized === "local-model"
  );
}

type AssistantStatus = "idle" | "loading_model" | "thinking";

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function ThinkingCard(props: { status: AssistantStatus }) {
  const isLoadingModel = props.status === "loading_model";
  return (
    <div class="rounded-xl border border-neutral-200 bg-white p-3">
      <div class="mb-1 text-xs font-bold tracking-wide text-neutral-500 uppercase">
        PoliteDB AI
      </div>

      <div class="flex items-center gap-2 text-sm text-neutral-700">
        <span>{isLoadingModel ? "Loading model" : "Thinking"}</span>
        <div class="flex items-center gap-1">
          <span class="size-2 animate-pulse rounded-full bg-neutral-400 [animation-delay:0ms]" />
          <span class="size-2 animate-pulse rounded-full bg-neutral-400 [animation-delay:150ms]" />
          <span class="size-2 animate-pulse rounded-full bg-neutral-400 [animation-delay:300ms]" />
        </div>
      </div>

      <div class="mt-2 text-xs text-neutral-500">
        {isLoadingModel
          ? "Starting the local model for the first request. This can take a little while."
          : "Generating a response..."}
      </div>
    </div>
  );
}

export function AiAssistantPanel(props: Props) {
  const {
    engine,
    runtimeConnectionId,
    activeSchema,
    tables,
    columnsByTable,
    currentSql,
    onInsertSql,
  } = props;

  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [loadingModels, setLoadingModels] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<AiRuntimeStatus | null>(
    null
  );
  const [assistantStatus, setAssistantStatus] =
    useState<AssistantStatus>("idle");
  const autoStartAttemptedRef = useRef(false);
  const preferredModelRef = useRef("");
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  const requestAbortRef = useRef<AbortController | null>(null);
  const requestSeqRef = useRef(0);

  useEffect(() => {
    const settings = getLocalAiSettings();
    setEndpoint(settings.endpoint);
    preferredModelRef.current = settings.model.trim();
    setModel(settings.model);
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const status = await aiRuntimeStatus();
        setRuntimeStatus(status);
        if (status.endpoint) setEndpoint(status.endpoint);
        if (
          status.missing.length === 0 &&
          status.phase === "stopped" &&
          !autoStartAttemptedRef.current
        ) {
          autoStartAttemptedRef.current = true;
          await handleStartBundledRuntime();
          return;
        }

        await handleLoadModels(status.endpoint ?? undefined);
      } catch {
        // ignore in web preview
      }
    })();
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  }, [messages, submitting]);

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;

    const updateScrollState = () => {
      const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      setShowScrollToBottom(distanceToBottom > 40);
    };

    updateScrollState();
    el.addEventListener("scroll", updateScrollState);
    return () => el.removeEventListener("scroll", updateScrollState);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({
      block: "end",
      behavior: "smooth",
    });
  };

  const canSubmit = useMemo(() => {
    return Boolean(prompt.trim() && endpoint.trim() && model.trim());
  }, [prompt, endpoint, model]);

  const handleLoadModels = async (endpointOverride?: string) => {
    setLoadingModels(true);
    try {
      const next = await listLocalAiModels(endpointOverride ?? endpoint);
      const normalizedNext = Array.from(
        new Set(next.map((item) => item.trim()).filter(Boolean))
      );
      const realOptions = normalizedNext.filter(
        (item) => !isBundledModelPlaceholder(item)
      );
      const selectableOptions =
        realOptions.length > 0 ? realOptions : normalizedNext;
      const nextModel =
        [
          model.trim(),
          preferredModelRef.current.trim(),
          runtimeStatus?.model_name?.trim() ?? "",
        ].find(
          (candidate) => candidate && selectableOptions.includes(candidate)
        ) ??
        selectableOptions[0] ??
        "";

      if (nextModel && nextModel !== model) {
        preferredModelRef.current = nextModel;
        setModel(nextModel);
      }
    } finally {
      setLoadingModels(false);
    }
  };

  const handleStartBundledRuntime = async () => {
    setRuntimeBusy(true);
    try {
      const status = await aiRuntimeStart();
      setRuntimeStatus(status);
      if (status.endpoint) setEndpoint(status.endpoint);
      // if (status.model_name) setModel(status.model_name);
      await handleLoadModels(status.endpoint ?? undefined);
    } finally {
      setRuntimeBusy(false);
    }
  };

  const handleStopBundledRuntime = async () => {
    setRuntimeBusy(true);
    try {
      const status = await aiRuntimeStop();
      setRuntimeStatus(status);
    } finally {
      setRuntimeBusy(false);
    }
  };

  const appendAssistantMessage = (
    message: Omit<ChatMessage, "id" | "role">
  ) => {
    setMessages((prev) => [
      ...prev,
      {
        id: makeId(),
        role: "assistant",
        ...message,
      },
    ]);
  };

  const handleCancelSubmit = () => {
    requestSeqRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
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
    setPrompt("");
    setSubmitting(true);
    setAssistantStatus("thinking");
    saveLocalAiSettings({ endpoint, model });

    setMessages((prev) => [
      ...prev,
      {
        id: makeId(),
        role: "user",
        text: question,
      },
    ]);

    try {
      if (isGeneralChatPrompt(question)) {
        const reply = await chatReply({
          endpoint,
          model,
          engine,
          question,
          activeSchema,
          tables,
          onStatusChange: (status) =>
            setAssistantStatus(
              status === "loading_model" ? "loading_model" : "thinking"
            ),
          signal: abortController.signal,
        });

        if (requestSeqRef.current !== requestId) return;

        appendAssistantMessage({
          text: [reply.answer, reply.followup].filter(Boolean).join("\n\n"),
        });
        return;
      }

      const plan = await planSqlFromQuestion({
        endpoint,
        model,
        engine,
        question,
        activeSchema,
        tables,
        columnsByTable,
        currentSql,
        onStatusChange: (status) =>
          setAssistantStatus(
            status === "loading_model" ? "loading_model" : "thinking"
          ),
        signal: abortController.signal,
      });

      if (requestSeqRef.current !== requestId) return;

      if (plan.needsClarification && !plan.sql) {
        appendAssistantMessage({
          text:
            plan.explanation || "I need more information to answer accurately.",
          clarification: plan.clarification,
          assumptions: plan.assumptions,
        });
        return;
      }

      if (runtimeConnectionId && plan.sql && isReadOnlySql(plan.sql)) {
        const result = await runSqlQuery(runtimeConnectionId, plan.sql, {
          maxRows: 200,
          batchSize: 200,
          timeoutMs: 45_000,
        });

        if (requestSeqRef.current !== requestId) return;

        const preview = queryResultToObjects(result, 20);
        const answer = await answerFromResult({
          endpoint,
          model,
          engine,
          question,
          sql: plan.sql,
          result,
          onStatusChange: (status) =>
            setAssistantStatus(
              status === "loading_model" ? "loading_model" : "thinking"
            ),
          signal: abortController.signal,
        });

        if (requestSeqRef.current !== requestId) return;

        appendAssistantMessage({
          text:
            answer.answer ||
            plan.explanation ||
            "I have run the query and got the result.",
          sql: plan.sql,
          assumptions: plan.assumptions,
          clarification: plan.needsClarification
            ? plan.clarification
            : undefined,
          resultPreview: preview,
          rowCount: Number(result.rowCount ?? preview.length),
          confidence: answer.confidence,
        });
        return;
      }

      appendAssistantMessage({
        text:
          plan.explanation ||
          "I haven't run the query yet, but here is the SQL that matches your request.",
        sql: plan.sql || undefined,
        assumptions: plan.assumptions,
        clarification: plan.needsClarification ? plan.clarification : undefined,
      });
    } catch (err) {
      if (isAbortError(err) || requestSeqRef.current !== requestId) {
        return;
      }
      const msg = formatError(err);
      appendAssistantMessage({
        text: `Cannot process this request: ${msg}`,
      });
    } finally {
      if (requestSeqRef.current === requestId) {
        requestAbortRef.current = null;
        setAssistantStatus("idle");
        setSubmitting(false);
      }
    }
  };

  return (
    <div class="flex h-full min-h-0 flex-col bg-white">
      <div class="shrink-0 border-b border-neutral-200 p-3">
        <div class="flex items-start justify-between gap-2">
          <div>
            <div class="text-sm font-semibold text-neutral-900">
              AI Assistant
            </div>
            <div class="mt-1 text-xs text-neutral-500">
              Chat with local model to ask data or get SQL suggestions.
            </div>
          </div>

          <Popover
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            positions={["bottom"]}
            align="end"
            padding={10}
            contentClassName="rounded-2xl"
            showArrow={false}
            content={
              <AiAssistantSettingsPopover
                loadingModels={loadingModels}
                runtimeBusy={runtimeBusy}
                runtimeStatus={runtimeStatus}
                onLoadModels={() => void handleLoadModels()}
                onStartRuntime={handleStartBundledRuntime}
                onStopRuntime={handleStopBundledRuntime}
              />
            }
          >
            <button
              type="button"
              title="AI settings"
              onClick={() => setSettingsOpen((prev) => !prev)}
              class={cn(
                "rounded-md border border-neutral-200 p-1 text-neutral-500 transition-colors hover:bg-neutral-100",
                settingsOpen && "border-blue-200 bg-blue-50 text-blue-700"
              )}
              aria-haspopup="dialog"
            >
              <Settings className="size-4" />
            </button>
          </Popover>
        </div>
      </div>

      <div
        ref={messagesContainerRef}
        class="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        <div class="space-y-3">
          <div class="space-y-3">
            {messages.length === 0 ? (
              <div class="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 p-4 text-sm text-neutral-500">
                Ask about data, get SQL suggestions, or describe the insight you
                want to see.
              </div>
            ) : null}

            {messages.map((message) => (
              <AiAssistantMessageCard
                key={message.id}
                message={message}
                onInsertSql={onInsertSql}
              />
            ))}

            {submitting ? <ThinkingCard status={assistantStatus} /> : null}

            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      {showScrollToBottom ? (
        <button
          type="button"
          onClick={scrollToBottom}
          title="Scroll to latest message"
          class="absolute right-4 bottom-42 z-10 rounded-full border border-neutral-200 bg-white p-2 text-neutral-600 shadow-md transition-colors hover:bg-neutral-50 hover:text-neutral-900"
        >
          <ArrowDown className="size-4" />
        </button>
      ) : null}

      <div class="shrink-0 border-t border-neutral-200 px-3 py-3">
        <div class="space-y-2">
          <textarea
            value={prompt}
            onInput={(e) => setPrompt(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleSubmit();
              }
            }}
            placeholder="Ask AI about data, or ask it to write SQL for you..."
            disabled={submitting}
            class="min-h-24 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
          />

          <div class="flex items-center justify-between gap-2">
            <div class="text-xs text-neutral-500">
              {runtimeConnectionId
                ? "Assistant will try to answer with real data when possible."
                : "No runtime connection: Assistant will return SQL or suggestions first."}
            </div>
            <Button
              class="py-1.5"
              onClick={submitting ? handleCancelSubmit : handleSubmit}
              loading={false}
              disabled={!canSubmit && !submitting}
              variant={submitting ? "primary" : "default"}
            >
              {submitting
                ? "Cancel"
                : assistantStatus === "loading_model"
                  ? "Loading model..."
                  : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
