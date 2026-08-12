import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  AiAssistantChatArea,
  type AiContextKind,
  type AiModelSelectionMode,
  type AiContextOption,
} from "src/components/ai-assistant/AiAssistantChatArea";
import { AiAssistantSettingsDialog } from "src/components/ai-assistant/AiAssistantSettingsDialog";
import { AiAssistantPanelHeader } from "src/components/ai-assistant/AiAssistantPanelHeader";
import {
  AiAssistantMissingModelPane,
  AiAssistantMissingRuntimePane,
  AiAssistantRuntimeLoadingPane,
} from "src/components/ai-assistant/AiAssistantRuntimePanes";
import { getLocalAiSettings } from "src/lib/ai-assistant";
import type {
  AiColumnMetadata,
  AiProviderKind,
  DatabaseEngine,
  TableItem,
} from "src/types";
import type { SavedConnectionSummary } from "src/lib/ai-assistant/types";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import {
  DEFAULT_LOCAL_AI_PROVIDER_ID,
  aiProviderList,
  ensureLocalAiProvider,
  getSelectedAiProviderId,
  normalizeAiProviderConfig,
  setSelectedAiProviderId,
} from "@root/src/lib/ai-assistant/providers";
import { useAiChatSession } from "./hooks/useAiChatSession";
import { useAiRuntimeManager } from "./hooks/useAiRuntimeManager";
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

  const initialSettingsRef = useRef<ReturnType<typeof getLocalAiSettings>>();
  if (!initialSettingsRef.current) {
    initialSettingsRef.current = getLocalAiSettings();
  }
  const initialSettings = initialSettingsRef.current;

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
  const [providerKind, setProviderKind] = useState<AiProviderKind | null>(null);
  const [providerModel, setProviderModel] = useState(initialSettings.model);
  const [providerLabel, setProviderLabel] = useState("Local API");
  const [providerOptions, setProviderOptions] = useState<
    ReturnType<typeof normalizeAiProviderConfig>[]
  >([]);
  const [selectedContextIds, setSelectedContextIds] = useState<AiContextKind[]>(
    []
  );

  const {
    endpoint,
    model,
    loadingModels,
    runtimeBusy,
    runtimeStatus,
    modelDownloadFailed,
    runtimeStartFailed,
    modelDownloadInProgress,
    showRuntimeLoadingScreen,
    showMissingModelScreen,
    showMissingRuntimeScreen,
    showSettings,
    handleStartBundledRuntime,
    handleStopBundledRuntime,
    handleRetryRuntimeSetup,
    handleDownloadModel,
    handleCancelModelDownload,
    handleRefreshRuntimeSetup,
  } = useAiRuntimeManager({
    initialEndpoint: initialSettings.endpoint,
    initialModel: initialSettings.model,
    submitting,
  });

  useEffect(() => {
    if (!endpoint.trim() || !model.trim()) return;
    void ensureLocalAiProvider({ endpoint, model }).then((provider) => {
      if (!providerId || providerId === DEFAULT_LOCAL_AI_PROVIDER_ID) {
        setProviderId(provider.id);
        setProviderKind(provider.kind);
        setProviderModel(provider.defaultModel);
        setProviderLabel(provider.label);
      }
    });
  }, [endpoint, model, providerId]);

  useEffect(() => {
    void aiProviderList().then((providers) => {
      const normalized = providers.map(normalizeAiProviderConfig);
      setProviderOptions(normalized);
      const selected = normalized.find((item) => item.id === providerId);
      setProviderKind(selected?.kind ?? null);
      if (selected?.defaultModel) {
        setProviderModel(selected.defaultModel);
      }
      if (selected?.label) {
        setProviderLabel(selected.label);
      }
    });
  }, [providerId]);

  useEffect(() => {
    const onSelected = (event: Event) => {
      const next = (event as CustomEvent<{ providerId?: string }>).detail
        ?.providerId;
      if (next) setProviderId(next);
    };
    window.addEventListener("politedb-ai-provider-selected", onSelected);
    return () =>
      window.removeEventListener("politedb-ai-provider-selected", onSelected);
  }, []);

  const handleSelectProvider = (nextProviderId: string) => {
    const selected = providerOptions.find((item) => item.id === nextProviderId);
    if (!selected) return;
    storeModelSelectionMode("manual");
    setModelSelectionMode("manual");
    setSelectedAiProviderId(selected.id);
    setProviderId(selected.id);
    setProviderKind(selected.kind);
    setProviderLabel(selected.label);
    setProviderModel(selected.defaultModel);
  };

  const handleSelectAutoModel = () => {
    storeModelSelectionMode("auto");
    setModelSelectionMode("auto");
    const selected =
      providerOptions.find(
        (item) => item.id === DEFAULT_LOCAL_AI_PROVIDER_ID
      ) ?? providerOptions[0];
    if (!selected) return;
    setSelectedAiProviderId(selected.id);
    setProviderId(selected.id);
    setProviderKind(selected.kind);
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
    providerId,
    endpoint,
    model: providerModel || model,
    engine,
    workspaceId: chatSessionKey,
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

  const shouldGateOnLocalRuntime =
    providerKind === "ollama" ||
    providerKind === "local_openai_compatible" ||
    (!providerKind && providerId === DEFAULT_LOCAL_AI_PROVIDER_ID);

  return (
    <div class="flex h-full min-h-0 max-w-full min-w-0 flex-col overflow-hidden bg-white">
      {presentation === "panel" ? (
        <AiAssistantPanelHeader
          showSettings={showSettings}
          settingsOpen={settingsOpen}
          onSettingsOpenChange={setSettingsOpen}
          loadingModels={loadingModels}
          runtimeBusy={runtimeBusy}
          runtimeStatus={runtimeStatus}
          onLoadModels={() => void handleRefreshRuntimeSetup()}
          onStartRuntime={handleStartBundledRuntime}
          onStopRuntime={handleStopBundledRuntime}
          onDownloadModel={() => void handleDownloadModel()}
        />
      ) : null}

      {presentation === "floating" ? (
        <AiAssistantSettingsDialog
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          loadingModels={loadingModels}
          runtimeBusy={runtimeBusy}
          runtimeStatus={runtimeStatus}
          onLoadModels={() => void handleRefreshRuntimeSetup()}
          onStartRuntime={handleStartBundledRuntime}
          onStopRuntime={handleStopBundledRuntime}
          onDownloadModel={() => void handleDownloadModel()}
        />
      ) : null}

      {shouldGateOnLocalRuntime && showRuntimeLoadingScreen ? (
        <AiAssistantRuntimeLoadingPane
          status={runtimeStatus}
          onRetry={() =>
            void (runtimeStartFailed
              ? handleRefreshRuntimeSetup()
              : handleRetryRuntimeSetup())
          }
          onCancelDownload={() => void handleCancelModelDownload()}
          showRetry={modelDownloadFailed || runtimeStartFailed}
          forceDownloading={modelDownloadInProgress}
        />
      ) : shouldGateOnLocalRuntime && showMissingRuntimeScreen ? (
        <AiAssistantMissingRuntimePane
          details={runtimeStatus?.last_error}
          onRetry={() => void handleRefreshRuntimeSetup()}
        />
      ) : shouldGateOnLocalRuntime && showMissingModelScreen ? (
        <AiAssistantMissingModelPane
          busy={runtimeBusy}
          onDownload={() => void handleDownloadModel()}
        />
      ) : (
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
          providerModel={providerModel || model}
          providerOptions={providerOptions}
          activeProviderId={providerId}
          modelSelectionMode={modelSelectionMode}
          onSelectAutoModel={handleSelectAutoModel}
          onSelectProvider={handleSelectProvider}
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
      )}
    </div>
  );
}
