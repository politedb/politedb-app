import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  AiAssistantChatArea,
  type AiContextKind,
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
import type { AiProviderKind, DatabaseEngine, TableItem } from "src/types";
import {
  DEFAULT_LOCAL_AI_PROVIDER_ID,
  aiProviderList,
  ensureLocalAiProvider,
  getSelectedAiProviderId,
  normalizeAiProviderConfig,
  setSelectedAiProviderId,
} from "src/lib/aiProviders";
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
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  currentSql?: string;
  onInsertSql?: (sql: string) => Promise<void> | void;
};

export function AiAssistantPanel(props: Props) {
  const {
    chatSessionKey,
    engine,
    presentation = "panel",
    onClose,
    runtimeConnectionId,
    activeSchema,
    tables,
    columnsByTable,
    currentSql,
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

    return [
      {
        id: "connection",
        label: "Current connection",
        detail: activeSchema || engine,
        available: Boolean(runtimeConnectionId || activeSchema || engine),
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
  const effectiveTables = includeMetadataContext ? tables : [];
  const effectiveColumnsByTable = includeMetadataContext ? columnsByTable : {};
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
    activeSchema: effectiveActiveSchema,
    tables: effectiveTables,
    columnsByTable: effectiveColumnsByTable,
    currentSql: effectiveCurrentSql,
  });
  const shouldGateOnLocalRuntime =
    providerKind === "ollama" ||
    providerKind === "local_openai_compatible" ||
    (!providerKind && providerId === DEFAULT_LOCAL_AI_PROVIDER_ID);

  return (
    <div class="flex h-full min-h-0 flex-col bg-white">
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
          providerLabel={providerLabel}
          providerModel={providerModel || model}
          providerOptions={providerOptions}
          activeProviderId={providerId}
          onSelectProvider={handleSelectProvider}
          contextOptions={contextOptions}
          onToggleContext={handleToggleContext}
          presentation={presentation}
          onClose={onClose}
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
