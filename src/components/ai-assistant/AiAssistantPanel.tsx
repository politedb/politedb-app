import { useRef, useState } from "preact/hooks";
import { AiAssistantChatArea } from "src/components/ai-assistant/AiAssistantChatArea";
import { AiAssistantPanelHeader } from "src/components/ai-assistant/AiAssistantPanelHeader";
import {
  AiAssistantMissingModelPane,
  AiAssistantMissingRuntimePane,
  AiAssistantRuntimeLoadingPane,
} from "src/components/ai-assistant/AiAssistantRuntimePanes";
import { getLocalAiSettings } from "src/lib/ai-assistant";
import type { DatabaseEngine, TableItem } from "src/types";
import { useAiChatSession } from "./hooks/useAiChatSession";
import { useAiRuntimeManager } from "./hooks/useAiRuntimeManager";
import {
  useAiAssistantSubmit,
  type AssistantStatus,
} from "./hooks/useAiAssistantSubmit";

type Props = {
  chatSessionKey: string;
  engine: DatabaseEngine;
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
    endpoint,
    model,
    engine,
    runtimeConnectionId,
    activeSchema,
    tables,
    columnsByTable,
    currentSql,
  });

  return (
    <div class="flex h-full min-h-0 flex-col bg-white">
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

      {showRuntimeLoadingScreen ? (
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
      ) : showMissingRuntimeScreen ? (
        <AiAssistantMissingRuntimePane
          details={runtimeStatus?.last_error}
          onRetry={() => void handleRefreshRuntimeSetup()}
        />
      ) : showMissingModelScreen ? (
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
        />
      )}
    </div>
  );
}
