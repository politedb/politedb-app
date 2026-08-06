import type { Ref } from "preact";
import { useState } from "preact/hooks";
import { AiAssistantMessageCard } from "src/components/ai-assistant/AiAssistantMessageCard";
import { AiAssistantThinkingCard } from "src/components/ai-assistant/AiAssistantThinkingCard";
import { Dropdown } from "src/components/common/Dropdown";
import { Popover } from "src/components/common/Popover";
import {
  ArrowRightIcon,
  ChatPlusIcon,
  ChevronDownIcon,
  MinusIcon,
  MoreVerticalIcon,
  ShareIcon,
  SparklesIcon,
  VaultIcon,
} from "src/components/icons";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import type { AssistantStatus } from "src/components/ai-assistant/hooks/useAiAssistantSubmit";
import type { AiChatSession, AiProviderConfig, ChatMessage } from "src/types";
import { normalizeLocalAiModelName } from "src/utils/assistant";
import { cn } from "src/utils/cn";
import { Button } from "../common/Button";
import { CheckMarkIcon } from "../icons/CheckMark";

export type AiContextKind = "connection" | "sql" | "metadata";
export type AiModelSelectionMode = "auto" | "manual";

export type AiContextOption = {
  id: AiContextKind;
  label: string;
  detail?: string;
  available: boolean;
  active: boolean;
};

function ProviderMark(props: { provider: AiProviderConfig }) {
  const { provider } = props;
  const color =
    provider.kind === "ollama" ? "text-emerald-600" : "text-neutral-700";

  return (
    <span class={cn("flex size-5 items-center justify-center", color)}>
      <VaultIcon className="size-4" />
    </span>
  );
}

function formatModelNameForDisplay(model: string) {
  return normalizeLocalAiModelName(model);
}

function messageText(message: ChatMessage) {
  if (message.parts?.length) {
    return message.parts
      .map((part) => {
        if (part.type === "text") return part.text;
        if (part.type === "sqlPreview") return part.sql;
        if (part.type === "error") return part.message;
        return "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  return message.text ?? "";
}

function AiModelPicker(props: {
  providerLabel: string;
  providerModel: string;
  providerOptions: AiProviderConfig[];
  activeProviderId: string;
  modelSelectionMode: AiModelSelectionMode;
  onSelectAutoModel: () => void;
  onSelectProvider: (providerId: string) => void;
}) {
  const {
    providerLabel,
    providerModel,
    providerOptions,
    activeProviderId,
    modelSelectionMode,
    onSelectAutoModel,
    onSelectProvider,
  } = props;
  const [open, setOpen] = useState(false);
  const enabledProviders = providerOptions.filter(
    (provider) => provider.enabled
  );
  const activeProvider = enabledProviders.find(
    (provider) => provider.id === activeProviderId
  );
  const activeModelLabel = formatModelNameForDisplay(providerModel);
  const autoSelected = modelSelectionMode === "auto" || !activeProvider;

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      positions={["top"]}
      align="end"
      padding={12}
      showArrow={false}
      contentClassName="rounded-2xl"
      content={
        <div class="w-80 overflow-hidden rounded-2xl border border-neutral-200 bg-white p-2 shadow-2xl">
          <button
            type="button"
            class="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm font-semibold text-neutral-900 hover:bg-neutral-100"
            onClick={() => {
              onSelectAutoModel();
              setOpen(false);
            }}
          >
            <SparklesIcon className="size-4 text-neutral-700" />
            <span class="min-w-0 flex-1">Auto</span>
            {autoSelected ? (
              <CheckMarkIcon className="size-4 text-neutral-900" />
            ) : null}
          </button>

          <div class="px-3 pt-3 pb-1 text-xs font-semibold text-neutral-500">
            Select a model{" "}
            <span class="rounded-md bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-500 uppercase">
              Beta
            </span>
          </div>

          <div class="max-h-80 overflow-y-auto">
            {enabledProviders.length ? (
              enabledProviders.map((provider) => {
                const active =
                  modelSelectionMode === "manual" &&
                  provider.id === activeProviderId;
                return (
                  <button
                    key={provider.id}
                    type="button"
                    class={cn(
                      "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-neutral-900",
                      active ? "bg-neutral-100" : "hover:bg-neutral-50"
                    )}
                    onClick={() => {
                      onSelectProvider(provider.id);
                      setOpen(false);
                    }}
                  >
                    <ProviderMark provider={provider} />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate">
                        {formatModelNameForDisplay(provider.defaultModel)}
                      </span>
                      <span class="block truncate text-xs text-neutral-400">
                        {provider.label}
                      </span>
                    </span>
                    {active ? (
                      <CheckMarkIcon className="size-4 text-neutral-900" />
                    ) : null}
                  </button>
                );
              })
            ) : (
              <div class="px-3 py-4 text-sm text-neutral-500">
                Add a provider in Settings to choose models.
              </div>
            )}
          </div>
        </div>
      }
    >
      <button
        type="button"
        title={`${providerLabel}: ${activeModelLabel}`}
        aria-label="Select AI model"
        onClick={() => setOpen((next) => !next)}
        class={cn(
          "inline-flex max-w-50 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-semibold transition-colors",
          open
            ? "bg-neutral-200 text-neutral-900"
            : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200"
        )}
      >
        <span class="truncate">{autoSelected ? "Auto" : activeModelLabel}</span>
      </button>
    </Popover>
  );
}

export function AiAssistantChatArea(props: {
  messages: ChatMessage[];
  onInsertSql?: (sql: string) => Promise<void> | void;
  messagesContainerRef: Ref<HTMLDivElement>;
  messagesEndRef: Ref<HTMLDivElement>;
  showScrollToBottom: boolean;
  onScrollToBottom: () => void;
  submitting: boolean;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  onCancelSubmit: () => void;
  canSubmit: boolean;
  assistantStatus: AssistantStatus;
  runtimeConnectionId?: string;
  providerLabel: string;
  providerModel: string;
  providerOptions: AiProviderConfig[];
  activeProviderId: string;
  modelSelectionMode: AiModelSelectionMode;
  onSelectAutoModel: () => void;
  onSelectProvider: (providerId: string) => void;
  contextOptions: AiContextOption[];
  onToggleContext: (contextId: AiContextKind) => void;
  presentation?: "panel" | "floating";
  onClose?: () => void;
  chatSessions: AiChatSession[];
  activeSessionId: string;
  onNewChat: () => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onSwitchSession: (sessionId: string) => void;
  onDeleteSession: (sessionId: string) => void;
  onOpenSettings: () => void;
}) {
  const {
    messages,
    onInsertSql,
    messagesContainerRef,
    messagesEndRef,
    showScrollToBottom,
    onScrollToBottom,
    submitting,
    prompt,
    onPromptChange,
    onSubmit,
    onCancelSubmit,
    canSubmit,
    assistantStatus,
    runtimeConnectionId,
    providerLabel,
    providerModel,
    providerOptions,
    activeProviderId,
    modelSelectionMode,
    onSelectAutoModel,
    onSelectProvider,
    contextOptions,
    onToggleContext,
    presentation = "panel",
    onClose,
    chatSessions,
    activeSessionId,
    onNewChat,
    onRenameSession,
    onSwitchSession,
    onDeleteSession,
    onOpenSettings,
  } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [contextTriggerStart, setContextTriggerStart] = useState<number | null>(
    null
  );
  const [titleOpen, setTitleOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const floating = presentation === "floating";
  const activeSession = chatSessions.find(
    (session) => session.id === activeSessionId
  );
  const activeTitle = activeSession?.title || "New Chat";
  const handleRenameActiveChat = () => {
    if (!activeSessionId) return;
    const title = window.prompt("Rename chat", activeTitle);
    if (title === null) return;
    onRenameSession(activeSessionId, title);
  };
  const handleDeleteActiveChat = () => {
    if (!activeSessionId) return;
    if (!window.confirm(`Delete chat "${activeTitle}"?`)) return;
    onDeleteSession(activeSessionId);
  };

  const menuItems = [
    {
      label: "Rename Chat",
      onSelect: handleRenameActiveChat,
    },
    {
      label: "Delete Chat",
      className: "text-red-600 hover:bg-red-50",
      onSelect: handleDeleteActiveChat,
    },
    {
      label: "History",
      separatorBefore: true,
      onSelect: () => setHistoryOpen(true),
    },
    {
      label: "Settings..",
      separatorBefore: true,
      onSelect: onOpenSettings,
    },
  ];

  const selectedContexts = contextOptions.filter(
    (item) => item.active && item.available
  );
  const contextItems = contextOptions.map((item) => ({
    key: item.id,
    label: item.label,
    disabled: !item.available,
    rightSlot: item.detail ? (
      <span class="max-w-20 truncate text-xs text-neutral-400">
        {item.detail}
      </span>
    ) : undefined,
    onSelect: () => {
      onToggleContext(item.id);
      if (contextTriggerStart !== null) {
        onPromptChange(
          `${prompt.slice(0, contextTriggerStart)}${prompt.slice(
            contextTriggerStart + 1
          )}`
        );
        setContextTriggerStart(null);
      }
    },
  }));

  const handleShare = async () => {
    const transcript = messages
      .map((message) => {
        const speaker = message.role === "user" ? "You" : "PoliteDB AI";
        const text = messageText(message).trim();
        return text ? `${speaker}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n\n");

    await navigator.clipboard.writeText(
      transcript || "PoliteDB AI chat is empty."
    );
    setShareCopied(true);
    window.setTimeout(() => setShareCopied(false), 1200);
  };

  const handlePromptInput = (value: string, cursorPosition: number | null) => {
    onPromptChange(value);
    const cursor = cursorPosition ?? value.length;
    const triggerIndex = cursor - 1;
    const justTypedAt = value[triggerIndex] === "@";
    const startsContextToken =
      justTypedAt && (triggerIndex === 0 || /\s/.test(value[triggerIndex - 1]));

    if (startsContextToken) {
      setContextTriggerStart(triggerIndex);
      setContextOpen(true);
      return;
    }

    if (contextTriggerStart !== null && value[contextTriggerStart] !== "@") {
      setContextTriggerStart(null);
      setContextOpen(false);
    }
  };

  return (
    <>
      {floating ? (
        <div class="relative flex shrink-0 items-center justify-between p-2">
          <div class="flex min-w-0 items-center gap-2">
            <Popover
              open={titleOpen}
              onOpenChange={setTitleOpen}
              positions={["bottom"]}
              align="start"
              padding={2}
              showArrow={false}
              content={
                <div class="w-70 rounded-2xl border border-neutral-200 bg-white px-2 py-3 shadow-2xl">
                  <div class="mb-2 px-2 text-sm font-semibold text-neutral-500">
                    Today
                  </div>
                  {chatSessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      class="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left text-base text-neutral-900 hover:bg-neutral-50"
                      onClick={() => {
                        onSwitchSession(session.id);
                        setTitleOpen(false);
                      }}
                    >
                      <span class="min-w-0 flex-1 truncate">
                        {session.title || "New Chat"}
                      </span>
                      {session.id === activeSessionId ? (
                        <CheckMarkIcon className="size-4" />
                      ) : null}
                    </button>
                  ))}
                </div>
              }
            >
              <div>
                <Button
                  variant="ghost"
                  onClick={() => setTitleOpen((open) => !open)}
                  class="max-w-65 rounded-full px-2 py-0.5 text-base"
                >
                  <span class="truncate">{activeTitle}</span>
                  <ChevronDownIcon className="size-4 shrink-0 text-neutral-500" />
                </Button>
              </div>
            </Popover>
          </div>

          <div class="flex items-center gap-1 text-neutral-800">
            <button
              type="button"
              class="flex items-center justify-center rounded-full p-1.5 text-neutral-700 hover:bg-neutral-100"
              title={shareCopied ? "Copied chat" : "Share chat"}
              aria-label={shareCopied ? "Copied chat" : "Share chat"}
              onClick={() => void handleShare()}
            >
              <ShareIcon className="size-5" />
            </button>
            {shareCopied ? (
              <div
                class={cn(
                  "absolute top-10 right-3 z-20 rounded-lg border border-neutral-200 bg-white px-3 py-1.5",
                  "flex items-center gap-2 text-xs font-semibold whitespace-nowrap text-neutral-700 shadow-lg"
                )}
              >
                <CheckMarkIcon class="size-4 rounded-full border border-neutral-300 p-px" />
                <span>Chat copied to clipboard</span>
              </div>
            ) : null}
            <button
              type="button"
              class="flex items-center justify-center rounded-full p-1.5 text-neutral-700 hover:bg-neutral-100"
              title="New chat"
              aria-label="New chat"
              onClick={onNewChat}
            >
              <ChatPlusIcon className="size-5" />
            </button>
            <Dropdown
              open={menuOpen}
              onOpenChange={setMenuOpen}
              positions={["bottom"]}
              align="end"
              widthClassName="w-44"
              items={menuItems}
              trigger={
                <div>
                  <button
                    type="button"
                    onClick={() => setMenuOpen((open) => !open)}
                    title="Chat menu"
                    aria-label="Chat menu"
                    class="flex items-center justify-center rounded-full p-1.5 text-neutral-700 hover:bg-neutral-100"
                  >
                    <MoreVerticalIcon className="size-5 rotate-90" />
                  </button>
                </div>
              }
            />
            <Button
              variant="ghost"
              class="rounded-full border-0 p-1.5 hover:bg-neutral-100"
              title="Minimize"
              onClick={onClose}
            >
              <MinusIcon className="size-4" />
            </Button>
          </div>
        </div>
      ) : null}

      <div
        ref={messagesContainerRef}
        class={cn(
          "min-h-0 flex-1 overflow-y-auto",
          floating ? "px-6 py-4" : "px-3 py-3"
        )}
      >
        <div class={cn(floating ? "space-y-6" : "space-y-3")}>
          <div class="space-y-1">
            {messages.length === 0 ? (
              <div class="rounded-xl border border-dashed border-neutral-200 bg-slate-50 p-4 text-[13px] text-neutral-500">
                Ask about data, get SQL suggestions, or describe the insight you
                want to see.
              </div>
            ) : null}

            {messages.map((message) => (
              <AiAssistantMessageCard
                key={message.id}
                message={message}
                presentation={presentation}
                onInsertSql={onInsertSql}
                runtimeConnectionId={runtimeConnectionId}
              />
            ))}

            {submitting && !messages.some((message) => message.streaming) ? (
              <AiAssistantThinkingCard />
            ) : null}

            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      {showScrollToBottom ? (
        <button
          type="button"
          onClick={onScrollToBottom}
          title="Scroll to latest message"
          class={cn(
            "absolute right-4 bottom-42 z-10 rounded-full border border-neutral-200",
            "bg-white p-2 text-neutral-600 shadow-md transition-colors hover:bg-neutral-50 hover:text-neutral-900"
          )}
        >
          <ChevronDownIcon className="size-4" />
        </button>
      ) : null}

      <div class="shrink-0 p-3">
        <div
          class={cn(
            "rounded-2xl border border-neutral-200 bg-white px-3 py-2 shadow-sm"
          )}
        >
          <div class={cn("mb-2 flex items-center justify-end gap-2")}>
            <div class="text-xs text-neutral-400">
              {submitting
                ? assistantStatus === "loading_model"
                  ? "Loading model..."
                  : "Generating..."
                : ""}
            </div>
          </div>

          {selectedContexts.length ? (
            <div class="mb-2 flex flex-wrap items-center gap-1.5">
              {selectedContexts.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  class="inline-flex max-w-full items-center gap-1 rounded-full bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200"
                  title={`Remove ${item.label}`}
                  onClick={() => onToggleContext(item.id)}
                >
                  <span class="truncate">{item.label}</span>
                  <span class="text-neutral-400">x</span>
                </button>
              ))}
            </div>
          ) : null}

          <Dropdown
            open={contextOpen}
            onOpenChange={(open) => {
              setContextOpen(open);
              if (!open) setContextTriggerStart(null);
            }}
            positions={["top"]}
            align="start"
            widthClassName="w-72"
            items={contextItems}
            itemClassName="whitespace-nowrap"
            trigger={
              <textarea
                value={prompt}
                onInput={(e) =>
                  handlePromptInput(
                    e.currentTarget.value,
                    e.currentTarget.selectionStart
                  )
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    if (submitting) {
                      onCancelSubmit();
                      return;
                    }
                    if (canSubmit) void onSubmit();
                  }
                }}
                placeholder="Ask anything..."
                disabled={submitting}
                class={cn(
                  "w-full resize-none border-none bg-transparent px-1 py-1 text-neutral-900 outline-none placeholder:text-neutral-400",
                  floating ? "min-h-20 text-base" : "min-h-14 text-sm"
                )}
              />
            }
          />

          <div class="mt-2 flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-2">
              {floating ? (
                <div />
              ) : (
                <>
                  <span class="inline-flex max-w-34 items-center gap-1 truncate rounded-md border border-neutral-200 px-2 py-1 text-xs font-medium text-neutral-700">
                    <VaultIcon className="size-3.5 shrink-0" />
                    <span class="truncate">{providerLabel}</span>
                  </span>
                  <span class="truncate text-xs font-medium text-neutral-500">
                    {formatModelNameForDisplay(providerModel)}
                  </span>
                </>
              )}
            </div>

            <div class="flex shrink-0 items-center gap-2">
              <AiModelPicker
                providerLabel={providerLabel}
                providerModel={providerModel}
                providerOptions={providerOptions}
                activeProviderId={activeProviderId}
                modelSelectionMode={modelSelectionMode}
                onSelectAutoModel={onSelectAutoModel}
                onSelectProvider={onSelectProvider}
              />

              {floating ? (
                <button
                  type="button"
                  class="rounded-full bg-neutral-100 p-2 text-neutral-300"
                  title={submitting ? "Stop" : "Send"}
                  aria-label={submitting ? "Stop" : "Send"}
                  onClick={() => {
                    if (submitting) {
                      onCancelSubmit();
                      return;
                    }
                    if (canSubmit) void onSubmit();
                  }}
                >
                  <ArrowRightIcon className="size-3.5 -rotate-90" />
                </button>
              ) : (
                <Dropdown
                  open={menuOpen}
                  onOpenChange={setMenuOpen}
                  positions={["top"]}
                  align="end"
                  widthClassName="w-44"
                  items={menuItems}
                  trigger={
                    <button
                      type="button"
                      onClick={() => setMenuOpen((open) => !open)}
                      title="Chat menu"
                      aria-label="Chat menu"
                      class={cn(
                        "rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-100",
                        menuOpen && "bg-neutral-100 text-neutral-900"
                      )}
                    >
                      <MoreVerticalIcon className="size-5" />
                    </button>
                  }
                />
              )}
            </div>
          </div>
        </div>
      </div>

      <Dialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        size="sm"
      >
        <DialogHeader>
          <DialogTitle>Chat History</DialogTitle>
        </DialogHeader>
        <DialogContent className="gap-2 pt-0 pb-6">
          {chatSessions.map((session) => (
            <div
              key={session.id}
              class={cn(
                "flex items-center justify-between gap-2 rounded-lg border px-3 py-2",
                session.id === activeSessionId
                  ? "border-blue-200 bg-blue-50"
                  : "border-neutral-200 bg-white"
              )}
            >
              <button
                type="button"
                class="min-w-0 flex-1 text-left"
                onClick={() => {
                  onSwitchSession(session.id);
                  setHistoryOpen(false);
                }}
              >
                <div class="truncate text-sm font-semibold text-neutral-900">
                  {session.title || "New Chat"}
                </div>
                <div class="text-xs text-neutral-500">
                  {new Date(session.updatedAt).toLocaleString()}
                </div>
              </button>
              <button
                type="button"
                class="rounded-md px-2 py-1 text-xs text-red-600 hover:bg-red-50"
                onClick={() => onDeleteSession(session.id)}
              >
                Delete
              </button>
            </div>
          ))}
        </DialogContent>
      </Dialog>
    </>
  );
}
