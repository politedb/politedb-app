import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  AiAssistantChatArea,
  type AiContextKind,
  type AiModelSelectionMode,
  type AiContextOption,
} from "src/components/ai-assistant/AiAssistantChatArea";
import { AiAssistantSettingsDialog } from "src/components/ai-assistant/AiAssistantSettingsDialog";
import { AiAssistantPanelHeader } from "src/components/ai-assistant/AiAssistantPanelHeader";
import type { AiColumnMetadata, DatabaseEngine, TableItem } from "src/types";
import type { SavedConnectionSummary } from "src/lib/ai-assistant/types";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import {
  aiProviderList,
  dismissLegacyLocalNotice,
  getSelectedAiProviderId,
  isLegacyBundledProvider,
  isLegacyLocalNoticeDismissed,
  isLocalAiProviderKind,
  normalizeAiProviderConfig,
  resolveSelectedAiProvider,
  setSelectedAiProviderId,
} from "@root/src/lib/ai-assistant/providers";
import { useAiChatSession } from "./hooks/useAiChatSession";
import {
  useAiAssistantSubmit,
  type AssistantStatus,
} from "./hooks/useAiAssistantSubmit";

type Props = {
  chatSessionKey: string;
  engine: DatabaseEngine;
  presentation?: "panel" | "floating";
  onClose?: () => void;
  runtimeConnectionId?: string;
  activeSchema?: string;
  activeTable?: TableItem;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  columnDetailsByTable?: Record<string, AiColumnMetadata[]>;
  currentSql?: string;
  querySafetyMode?: QuerySafetyMode;
  savedConnections?: SavedConnectionSummary[];
  onInsertSql?: (sql: string) => Promise<void> | void;
};

const AI_MODEL_SELECTION_MODE_KEY = "politedb.ai.model.selectionMode";
const AI_SELECTED_MODEL_KEY_PREFIX = "politedb.ai.model.selected.";

function getStoredModelSelectionMode(): AiModelSelectionMode {
  try {
    return window.localStorage.getItem(AI_MODEL_SELECTION_MODE_KEY) === "manual"
      ? "manual"
      : "auto";
  } catch {
    return "auto";
  }
}

function storeModelSelectionMode(mode: AiModelSelectionMode) {
  try {
    window.localStorage.setItem(AI_MODEL_SELECTION_MODE_KEY, mode);
  } catch {}
}

function getStoredProviderModel(providerId: string, fallback: string) {
  try {
    return (
      window.localStorage.getItem(
        `${AI_SELECTED_MODEL_KEY_PREFIX}${providerId}`
      ) ?? fallback
    );
  } catch {
    return fallback;
  }
}

function storeProviderModel(providerId: string, model: string) {
  try {
    window.localStorage.setItem(
      `${AI_SELECTED_MODEL_KEY_PREFIX}${providerId}`,
      model
    );
  } catch {}
}

function selectedModelForProvider(
  provider: ReturnType<typeof normalizeAiProviderConfig>
) {
  const stored = getStoredProviderModel(provider.id, provider.defaultModel);
  return provider.models?.includes(stored) ? stored : provider.defaultModel;
}

export function AiAssistantPanel(props: Props) {
  const {
    chatSessionKey,
    engine,
    presentation = "panel",
    onClose,
    runtimeConnectionId,
    activeSchema,
    activeTable,
    tables,
    columnsByTable,
    columnDetailsByTable,
    currentSql,
    querySafetyMode = "default",
    savedConnections,
    onInsertSql,
  } = props;

  const {
    prompt,
    setPrompt,
    messages,
    conversationState,
    chatSessions,
    activeSessionId,
    newChat,
    renameSession,
    switchSession,
    deleteSession,
    appendUserMessage,
    appendAssistantMessage,
    beginStreamingAssistantMessage,
    updateStreamingAssistantText,
    finalizeStreamingAssistantMessage,
    clearStreamingMessages,
    updateMessage,
    updateConversationState,
    messagesContainerRef,
    messagesEndRef,
    showScrollToBottom,
    scrollToBottom,
  } = useAiChatSession(chatSessionKey);

  const [submitting, setSubmitting] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assistantStatus, setAssistantStatus] =
    useState<AssistantStatus>("idle");
  const [providerId, setProviderId] = useState(() => getSelectedAiProviderId());
  const [modelSelectionMode, setModelSelectionMode] =
    useState<AiModelSelectionMode>(() => getStoredModelSelectionMode());
  const [providerModel, setProviderModel] = useState("");
  const [providerLabel, setProviderLabel] = useState("");
  const [providerOptions, setProviderOptions] = useState<
    ReturnType<typeof normalizeAiProviderConfig>[]
  >([]);
  const [selectedContextIds, setSelectedContextIds] = useState<AiContextKind[]>(
    []
  );

  const [legacyNoticeDismissed, setLegacyNoticeDismissed] = useState(() =>
    isLegacyLocalNoticeDismissed()
  );
  /** Enabled provider offered after the selected one became unavailable (plan R6). */
  const [pendingFallback, setPendingFallback] = useState<{
    id: string;
    label: string;
    model: string;
  } | null>(null);
  /** Sessions whose unavailable original provider the user already accepted replacing. */
  const [acceptedSessionIds, setAcceptedSessionIds] = useState<string[]>([]);

  const selectableProviderOptions = useMemo(
    () => providerOptions.filter((provider) => provider.enabled),
    [providerOptions]
  );
  const selectedProviderOption = providerOptions.find(
    (provider) => provider.id === providerId
  );
  const showLegacyNotice =
    !legacyNoticeDismissed &&
    providerOptions.some((provider) => isLegacyBundledProvider(provider));

  const applyProviderList = (
    providers: ReturnType<typeof normalizeAiProviderConfig>[],
    currentId: string
  ) => {
    setProviderOptions(providers);
    const selected = resolveSelectedAiProvider(providers, currentId);
    if (!selected) {
      // Nothing enabled: clear the selection so submit stays disabled (plan R5).
      if (currentId) setSelectedAiProviderId("");
      setProviderId("");
      setProviderModel("");
      setProviderLabel("");
      return;
    }
    if (currentId && selected.id !== currentId) {
      // The previously used provider is gone or disabled. Never switch silently: a
      // conversation that ran on a local server must not move to another provider
      // (possibly a cloud one) without the user choosing it (plan R6).
      setPendingFallback({
        id: selected.id,
        label: selected.label,
        model: selectedModelForProvider(selected),
      });
      return;
    }
    setPendingFallback(null);
    if (selected.id !== currentId) {
      setSelectedAiProviderId(selected.id);
      setProviderId(selected.id);
    }
    setProviderModel(selectedModelForProvider(selected));
    setProviderLabel(selected.label);
  };

  const confirmFallback = () => {
    if (!pendingFallback) return;
    setPendingFallback(null);
    // Switch provider, model and label together so the first request after Continue
    // never pairs the new provider with the old provider's model.
    setProviderModel(pendingFallback.model);
    setProviderLabel(pendingFallback.label);
    setSelectedAiProviderId(pendingFallback.id);
    setProviderId(pendingFallback.id);
  };

  useEffect(() => {
    void aiProviderList().then((providers) => {
      applyProviderList(providers.map(normalizeAiProviderConfig), providerId);
    });
  }, [providerId]);

  useEffect(() => {
    const refreshProviders = () => {
      void aiProviderList().then((providers) => {
        applyProviderList(providers.map(normalizeAiProviderConfig), providerId);
      });
    };
    window.addEventListener("politedb-ai-providers-changed", refreshProviders);
    return () =>
      window.removeEventListener(
        "politedb-ai-providers-changed",
        refreshProviders
      );
  }, [providerId]);

  useEffect(() => {
    const onSelected = (event: Event) => {
      const next = (event as CustomEvent<{ providerId?: string }>).detail
        ?.providerId;
      setProviderId(next ?? "");
    };
    window.addEventListener("politedb-ai-provider-selected", onSelected);
    return () =>
      window.removeEventListener("politedb-ai-provider-selected", onSelected);
  }, []);

  const handleSelectProviderModel = (
    nextProviderId: string,
    nextModel: string
  ) => {
    const selected = selectableProviderOptions.find(
      (item) => item.id === nextProviderId
    );
    if (!selected) return;
    // Picking a model is an explicit choice of provider, also for an old session
    // whose original provider is gone (its stored attribution is left untouched).
    setPendingFallback(null);
    if (activeSessionId) {
      setAcceptedSessionIds((ids) =>
        ids.includes(activeSessionId) ? ids : [...ids, activeSessionId]
      );
    }
    storeModelSelectionMode("manual");
    setModelSelectionMode("manual");
    setSelectedAiProviderId(selected.id);
    setProviderId(selected.id);
    setProviderLabel(selected.label);
    storeProviderModel(selected.id, nextModel);
    setProviderModel(nextModel);
  };

  const handleSelectAutoModel = () => {
    // Choosing Auto is an explicit choice too, including for an old session whose
    // original provider is gone (its stored attribution is left untouched).
    setPendingFallback(null);
    if (activeSessionId) {
      setAcceptedSessionIds((ids) =>
        ids.includes(activeSessionId) ? ids : [...ids, activeSessionId]
      );
    }
    storeModelSelectionMode("auto");
    setModelSelectionMode("auto");
    const selected =
      selectableProviderOptions.find(
        (item) => item.isDefault && item.enabled
      ) ?? selectableProviderOptions.find((item) => item.enabled);
    if (!selected) return;
    setSelectedAiProviderId(selected.id);
    setProviderId(selected.id);
    setProviderLabel(selected.label);
    setProviderModel(selected.defaultModel);
  };

  const contextOptions = useMemo<AiContextOption[]>(() => {
    const trimmedSql = currentSql?.trim() ?? "";
    const sqlPreview = trimmedSql
      ? `${trimmedSql.split(/\s+/).slice(0, 4).join(" ")}${
          trimmedSql.split(/\s+/).length > 4 ? "..." : ""
        }`
      : undefined;
    const hasConnectionContext = Boolean(
      runtimeConnectionId || activeSchema || tables.length > 0
    );

    return [
      {
        id: "connection",
        label: "Current connection",
        detail: activeSchema || (runtimeConnectionId ? engine : undefined),
        available: hasConnectionContext,
        active: selectedContextIds.includes("connection"),
      },
      {
        id: "sql",
        label: "Current SQL editor",
        detail: sqlPreview,
        available: Boolean(trimmedSql),
        active: selectedContextIds.includes("sql"),
      },
      {
        id: "metadata",
        label: "Visible schema metadata",
        detail: tables.length
          ? `${tables.length} table${tables.length === 1 ? "" : "s"}`
          : undefined,
        available: tables.length > 0,
        active: selectedContextIds.includes("metadata"),
      },
    ];
  }, [
    activeSchema,
    currentSql,
    engine,
    runtimeConnectionId,
    selectedContextIds,
    tables.length,
  ]);

  const handleToggleContext = (contextId: AiContextKind) => {
    const option = contextOptions.find((item) => item.id === contextId);
    if (!option?.available) return;
    setSelectedContextIds((current) =>
      current.includes(contextId)
        ? current.filter((item) => item !== contextId)
        : [...current, contextId]
    );
  };

  const availableSelectedContextIds = selectedContextIds.filter((contextId) =>
    contextOptions.some((item) => item.id === contextId && item.available)
  );
  const hasExplicitContext = availableSelectedContextIds.length > 0;
  const includeConnectionContext =
    !hasExplicitContext || availableSelectedContextIds.includes("connection");
  const includeSqlContext =
    !hasExplicitContext || availableSelectedContextIds.includes("sql");
  const includeMetadataContext =
    !hasExplicitContext || availableSelectedContextIds.includes("metadata");
  const effectiveActiveSchema =
    includeConnectionContext || includeMetadataContext
      ? activeSchema
      : undefined;
  const effectiveActiveTable =
    includeConnectionContext || includeMetadataContext
      ? activeTable
      : undefined;
  const effectiveTables = includeMetadataContext ? tables : [];
  const effectiveColumnsByTable = includeMetadataContext ? columnsByTable : {};
  const effectiveColumnDetailsByTable = includeMetadataContext
    ? columnDetailsByTable
    : {};
  const effectiveCurrentSql = includeSqlContext ? currentSql : undefined;

  const activeSession = chatSessions.find(
    (session) => session.id === activeSessionId
  );
  const sessionProviderUnavailable = Boolean(
    activeSession?.providerId &&
    activeSession.providerId !== providerId &&
    !acceptedSessionIds.includes(activeSession.id) &&
    !selectableProviderOptions.some(
      (provider) => provider.id === activeSession.providerId
    )
  );
  const submitBlocked = Boolean(pendingFallback) || sessionProviderUnavailable;

  const { canSubmit, handleSubmit, handleCancelSubmit } = useAiAssistantSubmit({
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
    // Blocked until the user confirms a replacement provider (plan R6).
    providerId: submitBlocked ? "" : providerId,
    isLocalProvider: Boolean(
      selectedProviderOption &&
      isLocalAiProviderKind(selectedProviderOption.kind)
    ),
    model: providerModel,
    engine,
    runtimeConnectionId,
    activeSchema: effectiveActiveSchema,
    activeTable: effectiveActiveTable,
    tables: effectiveTables,
    columnsByTable: effectiveColumnsByTable,
    columnDetailsByTable: effectiveColumnDetailsByTable,
    currentSql: effectiveCurrentSql,
    savedConnections,
    conversationState,
    updateConversationState,
  });
  const cancelSubmitRef = useRef(handleCancelSubmit);
  useEffect(() => {
    cancelSubmitRef.current = handleCancelSubmit;
  }, [handleCancelSubmit]);

  useEffect(() => {
    return () => {
      cancelSubmitRef.current();
    };
  }, []);

  const handleClose = () => {
    handleCancelSubmit();
    onClose?.();
  };

  return (
    <div class="flex h-full min-h-0 max-w-full min-w-0 flex-col overflow-hidden bg-slate-50">
      {presentation === "panel" ? (
        <AiAssistantPanelHeader
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
        />
      ) : null}

      {presentation === "floating" ? (
        <AiAssistantSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      {pendingFallback || sessionProviderUnavailable ? (
        <div class="flex shrink-0 items-start justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span>
            {pendingFallback
              ? `The AI provider you used before is no longer available. Continue with ${pendingFallback.label}?`
              : `This chat was started with an AI provider that is no longer available. Continue it with ${providerLabel || "the selected provider"}?`}
          </span>
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              class="font-medium underline"
              onClick={() => {
                if (pendingFallback) confirmFallback();
                else if (activeSession)
                  setAcceptedSessionIds((ids) => [...ids, activeSession.id]);
              }}
            >
              Continue
            </button>
            <button
              type="button"
              class="underline"
              onClick={() => setSettingsOpen(true)}
            >
              Open AI settings
            </button>
          </div>
        </div>
      ) : null}

      {showLegacyNotice ? (
        <div class="flex shrink-0 items-start justify-between gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <span>
            PoliteDB's built-in AI was removed. Point your local provider at
            your own Ollama server in AI settings.
          </span>
          <div class="flex shrink-0 gap-2">
            <button
              type="button"
              class="font-medium underline"
              onClick={() => setSettingsOpen(true)}
            >
              Open AI settings
            </button>
            <button
              type="button"
              class="underline"
              onClick={() => {
                dismissLegacyLocalNotice();
                setLegacyNoticeDismissed(true);
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <div class="flex min-h-0 flex-1 flex-col">
        <AiAssistantChatArea
          messages={messages}
          onInsertSql={onInsertSql}
          messagesContainerRef={messagesContainerRef}
          messagesEndRef={messagesEndRef}
          showScrollToBottom={showScrollToBottom}
          onScrollToBottom={scrollToBottom}
          submitting={submitting}
          prompt={prompt}
          onPromptChange={setPrompt}
          onSubmit={handleSubmit}
          onCancelSubmit={handleCancelSubmit}
          canSubmit={canSubmit}
          assistantStatus={assistantStatus}
          runtimeConnectionId={runtimeConnectionId}
          querySafetyMode={querySafetyMode}
          onUpdateMessage={updateMessage}
          providerLabel={providerLabel}
          providerModel={providerModel}
          providerOptions={selectableProviderOptions}
          activeProviderId={providerId}
          modelSelectionMode={modelSelectionMode}
          onSelectAutoModel={handleSelectAutoModel}
          onSelectProviderModel={handleSelectProviderModel}
          contextOptions={contextOptions}
          onToggleContext={handleToggleContext}
          presentation={presentation}
          onClose={handleClose}
          chatSessions={chatSessions}
          activeSessionId={activeSessionId}
          onNewChat={newChat}
          onRenameSession={renameSession}
          onSwitchSession={switchSession}
          onDeleteSession={deleteSession}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>
    </div>
  );
}
