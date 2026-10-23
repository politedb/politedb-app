import type { Ref } from "preact";
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { AssistantModePicker } from "./AssistantModePicker";
import {
  AiAssistantMessageCard,
  AssistantStreamingPlaceholder,
} from "src/components/ai-assistant/AiAssistantMessageCard";
import { Dropdown } from "src/components/common/Dropdown";
import { Popover } from "src/components/common/Popover";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";
import {
  ArrowRightIcon,
  ChatPlusIcon,
  ChevronDownIcon,
  ClockIcon,
  CopyIcon,
  EditIcon,
  MinusIcon,
  MoreVerticalIcon,
  SparklesIcon,
  VaultIcon,
  XIcon,
} from "src/components/icons";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "src/components/common/Dialog";
import { Input } from "src/components/common/Input";
import type { AssistantStatus } from "src/components/ai-assistant/hooks/useAiAssistantSubmit";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import { confirmDialog } from "src/lib/system-dialog";
import type { AiChatSession, AiProviderConfig, ChatMessage } from "src/types";
import { cn } from "src/utils/cn";
import { sessionDayLabel } from "src/utils/connectionLog";
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
  return model.trim();
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
  onSelectProviderModel: (providerId: string, model: string) => void;
}) {
  const {
    providerLabel,
    providerModel,
    providerOptions,
    activeProviderId,
    modelSelectionMode,
    onSelectAutoModel,
    onSelectProviderModel,
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
            <span class="min-w-0 flex-1">
              <span class="block">Auto</span>
              <span class="block text-xs font-normal text-neutral-500">
                The default provider and its default model
              </span>
            </span>
            {autoSelected ? (
              <CheckMarkIcon className="size-4 text-neutral-900" />
            ) : null}
          </button>

          <div class="px-3 pt-3 pb-1 text-xs font-semibold text-neutral-500">
            Select a model
          </div>

          <OverlayScrollArea className="max-h-80">
            {enabledProviders.length ? (
              enabledProviders.flatMap((provider) =>
                (provider.models?.length
                  ? provider.models
                  : [provider.defaultModel]
                ).map((model) => {
                  const active =
                    modelSelectionMode === "manual" &&
                    provider.id === activeProviderId &&
                    model === providerModel;
                  return (
                    <button
                      key={`${provider.id}:${model}`}
                      type="button"
                      class={cn(
                        "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left text-sm text-neutral-900",
                        active ? "bg-neutral-100" : "hover:bg-neutral-50"
                      )}
                      onClick={() => {
                        onSelectProviderModel(provider.id, model);
                        setOpen(false);
                      }}
                    >
                      <ProviderMark provider={provider} />
                      <span class="min-w-0 flex-1">
                        <span class="block truncate">
                          {formatModelNameForDisplay(model)}
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
              )
            ) : (
              <div class="px-3 py-4 text-sm text-neutral-500">
                Add a provider in Settings to choose models.
              </div>
            )}
          </OverlayScrollArea>
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
  querySafetyMode?: QuerySafetyMode;
  onUpdateMessage: (id: string, patch: Partial<ChatMessage>) => void;
  onAllowDataAccess?: (question: string) => Promise<boolean>;
  providerLabel: string;
  providerModel: string;
  providerOptions: AiProviderConfig[];
  activeProviderId: string;
  modelSelectionMode: AiModelSelectionMode;
  onSelectAutoModel: () => void;
  onSelectProviderModel: (providerId: string, model: string) => void;
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
    querySafetyMode = "default",
    onUpdateMessage,
    onAllowDataAccess,
    providerLabel,
    providerModel,
    providerOptions,
    activeProviderId,
    modelSelectionMode,
    onSelectAutoModel,
    onSelectProviderModel,
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
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [copyChatResult, setCopyChatResult] = useState<
    "copied" | "failed" | null
  >(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const historyListRef = useRef<HTMLDivElement>(null);
  // The prompt takes focus for a newly shown chat once no dialog covers it.
  const focusPromptRef = useRef(true);
  const floating = presentation === "floating";
  const activeSession = chatSessions.find(
    (session) => session.id === activeSessionId
  );
  const activeTitle = activeSession?.title || "New Chat";

  useLayoutEffect(() => {
    if (typeof messagesContainerRef === "function") return;
    const container = messagesContainerRef?.current;
    if (!container) return;
    container.scrollTop = container.scrollHeight;
  }, [activeSessionId, messagesContainerRef]);

  // Ready to type when the chat opens, after switching chats (once History or
  // Rename closes), and once an answer ends, unless the user has moved on to
  // something outside the composer.
  useEffect(() => {
    focusPromptRef.current = true;
  }, [activeSessionId]);
  // The prompt grows with its text up to its max height, then scrolls.
  useLayoutEffect(() => {
    const textarea = promptRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  }, [prompt]);
  useEffect(() => {
    if (historyOpen || renameOpen || !focusPromptRef.current) return;
    focusPromptRef.current = false;
    promptRef.current?.focus();
  }, [activeSessionId, historyOpen, renameOpen]);
  useEffect(() => {
    if (submitting || historyOpen || renameOpen) return;
    const active = document.activeElement;
    if (
      !active ||
      active === document.body ||
      composerRef.current?.contains(active)
    ) {
      promptRef.current?.focus();
    }
  }, [submitting]);
  const handleRenameActiveChat = () => {
    if (!activeSessionId) return;
    setRenameTitle(activeTitle);
    setRenameOpen(true);
  };
  const submitRename = () => {
    const title = renameTitle.trim();
    if (!activeSessionId || !title) return;
    onRenameSession(activeSessionId, title);
    setRenameOpen(false);
  };
  const confirmDeleteChat = async (
    sessionId: string,
    title: string,
    fromHistory = false
  ) => {
    const ok = await confirmDialog(
      `Delete the chat "${title}"? This cannot be undone.`,
      {
        title: "Delete chat",
        kind: "warning",
        okLabel: "Delete",
        cancelLabel: "Cancel",
      }
    );
    if (!ok) return;
    onDeleteSession(sessionId);
    // The focused Delete button left with its row: stay inside History.
    if (fromHistory) {
      window.requestAnimationFrame(() =>
        historyListRef.current?.querySelector("button")?.focus()
      );
    }
  };
  const handleDeleteActiveChat = () => {
    if (!activeSessionId) return;
    void confirmDeleteChat(activeSessionId, activeTitle);
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
      label: "Settings...",
      separatorBefore: true,
      onSelect: onOpenSettings,
    },
  ];

  const selectedContexts = contextOptions.filter(
    (item) => item.active && item.available
  );
  const availableContextOptions = contextOptions.filter(
    (item) => item.available
  );
  const contextItems = availableContextOptions.length
    ? availableContextOptions.map((item) => ({
        key: item.id,
        label: item.label,
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
      }))
    : [
        {
          key: "no-context",
          label: "Open a connection to add context",
          disabled: true,
        },
      ];

  const handleCopyChat = async () => {
    const transcript = messages
      .map((message) => {
        const speaker = message.role === "user" ? "You" : "PoliteDB AI";
        const text = messageText(message).trim();
        return text ? `${speaker}: ${text}` : "";
      })
      .filter(Boolean)
      .join("\n\n");

    try {
      await navigator.clipboard.writeText(
        transcript || "PoliteDB AI chat is empty."
      );
      setCopyChatResult("copied");
    } catch {
      setCopyChatResult("failed");
    }
    window.setTimeout(() => setCopyChatResult(null), 1500);
  };

  const enabledProviderCount = providerOptions.filter(
    (provider) => provider.enabled
  ).length;
  const startWith = (text: string) => {
    onPromptChange(text);
    promptRef.current?.focus();
  };
  const suggestions = runtimeConnectionId
    ? [
        "Which tables are the largest?",
        "Summarize how the tables in this database are related",
        "Help me write a query",
      ]
    : [
        "Explain the difference between a LEFT JOIN and an INNER JOIN",
        "Help me write a query",
      ];
  // Newest first, under day headings ("Today", "Yesterday", "Mon, Oct 19").
  const now = Date.now();
  const sessionGroups: { label: string; sessions: AiChatSession[] }[] = [];
  for (const session of [...chatSessions].sort(
    (a, b) => b.updatedAt - a.updatedAt
  )) {
    const label = sessionDayLabel(session.updatedAt, now);
    const group = sessionGroups[sessionGroups.length - 1];
    if (group?.label === label) group.sessions.push(session);
    else sessionGroups.push({ label, sessions: [session] });
  }

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
        <div class="relative flex shrink-0 items-center justify-between p-2 shadow-xs">
          <div class="flex min-w-0 items-center gap-2">
            <Popover
              open={titleOpen}
              onOpenChange={setTitleOpen}
              positions={["bottom"]}
              align="start"
              padding={2}
              showArrow={false}
              content={
                <div class="w-70 overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-2xl">
                  <OverlayScrollArea
                    className="max-h-[min(24rem,60vh)]"
                    contentClassName="px-2 py-3"
                  >
                    {sessionGroups.map((group) => (
                      <div key={group.label} class="not-first:mt-2">
                        <div class="mb-1 px-2 text-xs font-semibold text-neutral-500">
                          {group.label}
                        </div>
                        {group.sessions.map((session) => (
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
                    ))}
                  </OverlayScrollArea>
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
              title="Copy chat"
              aria-label="Copy chat"
              onClick={() => void handleCopyChat()}
            >
              <CopyIcon className="size-5" />
            </button>
            {copyChatResult ? (
              <div
                role="status"
                class={cn(
                  "absolute top-10 right-3 z-20 rounded-lg border bg-white px-3 py-1.5",
                  "flex items-center gap-2 text-xs font-semibold whitespace-nowrap shadow-lg",
                  copyChatResult === "copied"
                    ? "border-neutral-200 text-neutral-700"
                    : "border-red-200 text-red-700"
                )}
              >
                {copyChatResult === "copied" ? (
                  <>
                    <CheckMarkIcon class="size-4 rounded-full border border-neutral-300 p-px" />
                    <span>Chat copied to clipboard</span>
                  </>
                ) : (
                  <span>Could not copy the chat</span>
                )}
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
          "no-scrollbar min-h-0 max-w-full min-w-0 flex-1 overflow-x-hidden overflow-y-auto",
          floating ? "px-6 py-4" : "px-3 py-3"
        )}
      >
        <div
          class={cn(
            "w-full max-w-full min-w-0 overflow-hidden",
            floating ? "space-y-6" : "space-y-3"
          )}
        >
          <div class="w-full max-w-full min-w-0 space-y-1 overflow-hidden">
            {messages.length === 0 && enabledProviderCount === 0 ? (
              <div class="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
                <div class="font-semibold text-neutral-900">
                  Set up an AI provider
                </div>
                <p class="mt-1">
                  Add a provider and its API key, or a local Ollama server, to
                  start chatting.
                </p>
                <Button class="mt-3" onClick={onOpenSettings}>
                  Open AI settings
                </Button>
              </div>
            ) : messages.length === 0 ? (
              <div class="space-y-3 text-sm text-neutral-600">
                <p>
                  Ask about your data, get SQL suggestions, or describe the
                  insight you want to see.
                </p>
                <div class="flex flex-col items-start gap-2">
                  {suggestions.map((text) => (
                    <button
                      key={text}
                      type="button"
                      class="rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-left text-sm text-neutral-700 hover:bg-neutral-50"
                      onClick={() => startWith(text)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                {availableContextOptions.length ? (
                  <p class="text-xs text-neutral-500">
                    Type @ to add context, such as the current connection or
                    SQL.
                  </p>
                ) : null}
              </div>
            ) : null}

            {messages.map((message) => (
              <AiAssistantMessageCard
                key={message.id}
                message={message}
                presentation={presentation}
                onInsertSql={onInsertSql}
                runtimeConnectionId={runtimeConnectionId}
                querySafetyMode={querySafetyMode}
                onUpdateMessage={onUpdateMessage}
                onAllowDataAccess={onAllowDataAccess}
              />
            ))}

            {submitting && !messages.some((message) => message.streaming) ? (
              <AssistantStreamingPlaceholder />
            ) : null}

            <div ref={messagesEndRef} />
          </div>
        </div>
      </div>

      <div class="relative shrink-0 p-3">
        {/* Sits just above the composer, however tall it grows. */}
        {showScrollToBottom ? (
          <button
            type="button"
            onClick={onScrollToBottom}
            title="Scroll to latest message"
            aria-label="Scroll to latest message"
            class={cn(
              "absolute bottom-full left-1/2 z-10 mb-1 -translate-x-1/2 rounded-full border border-neutral-200",
              "flex size-9 items-center justify-center bg-neutral-700 text-white shadow-md",
              "transition-colors hover:bg-neutral-700",
              submitting
                ? "px-3 py-1 text-sm leading-none tracking-widest"
                : "p-1.5"
            )}
          >
            {submitting ? (
              <span aria-hidden="true">•••</span>
            ) : (
              <ChevronDownIcon className="size-4" aria-hidden="true" />
            )}
          </button>
        ) : null}

        {/* The composer proper: the scroll button above stays out of it, so it
            keeps focus when an answer ends. */}
        <div
          ref={composerRef}
          class={cn(
            "rounded-2xl border border-neutral-200 bg-white px-3 py-2 shadow-sm"
          )}
        >
          {submitting && assistantStatus === "loading_model" ? (
            <div class="mb-1 text-right text-xs text-neutral-400">
              Loading model...
            </div>
          ) : null}

          {selectedContexts.length ? (
            <div class="mb-2 flex flex-wrap items-center gap-1.5">
              {selectedContexts.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  class="inline-flex max-w-full items-center gap-1 rounded-full bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-600 hover:bg-neutral-200"
                  title={`Remove ${item.label}`}
                  aria-label={`Remove ${item.label}`}
                  onClick={() => onToggleContext(item.id)}
                >
                  <span class="truncate">{item.label}</span>
                  <XIcon className="size-3 text-neutral-400" />
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
                ref={promptRef}
                value={prompt}
                onInput={(e) =>
                  handlePromptInput(
                    e.currentTarget.value,
                    e.currentTarget.selectionStart
                  )
                }
                onKeyDown={(e) => {
                  // Enter that ends an IME composition (Vietnamese, Japanese…)
                  // only commits the text.
                  if (e.isComposing || e.keyCode === 229) return;
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    // The next question can be typed during an answer and sent
                    // with Enter once it ends; Stop cancels the answer.
                    if (!submitting && canSubmit) void onSubmit();
                  }
                }}
                placeholder="Ask anything..."
                class={cn(
                  "max-h-50 w-full resize-none overflow-y-auto border-none bg-transparent px-1 py-1 text-neutral-900 outline-none placeholder:text-neutral-400",
                  floating ? "min-h-20 text-base" : "min-h-14 text-sm"
                )}
              />
            }
          />

          <div class="mt-2 flex items-center justify-between gap-2">
            <div class="flex min-w-0 items-center gap-2">
              {runtimeConnectionId ? <AssistantModePicker /> : null}
              {floating ? null : (
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
                onSelectProviderModel={onSelectProviderModel}
              />

              {floating ? (
                <button
                  type="button"
                  class={cn(
                    "rounded-full p-2.5 transition-colors",
                    submitting
                      ? "bg-blue-600 text-white hover:bg-blue-700"
                      : canSubmit
                        ? "bg-blue-600 text-white hover:bg-blue-700"
                        : "bg-neutral-100 text-neutral-300"
                  )}
                  title={submitting ? "Stop" : "Send"}
                  aria-label={submitting ? "Stop" : "Send"}
                  disabled={!submitting && !canSubmit}
                  onClick={() => {
                    if (submitting) {
                      onCancelSubmit();
                      return;
                    }
                    if (canSubmit) void onSubmit();
                  }}
                >
                  {submitting ? (
                    <span class="block size-2 rounded-xs bg-current" />
                  ) : (
                    <ArrowRightIcon className="size-3 -rotate-90" />
                  )}
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

      <Dialog open={renameOpen} onClose={() => setRenameOpen(false)} size="md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submitRename();
          }}
        >
          <DialogHeader className="border-b border-neutral-200">
            <DialogTitle className="flex items-center gap-2 font-semibold">
              <EditIcon className="size-4.5 shrink-0" />
              Rename Chat
            </DialogTitle>
          </DialogHeader>
          <DialogContent className="pt-2">
            <Input
              label="Chat name"
              value={renameTitle}
              onValueChange={setRenameTitle}
              placeholder="Enter new name..."
              aria-label="Chat name"
              autofocus
              className="h-9 border border-neutral-200 bg-white text-sm"
            />
          </DialogContent>
          <DialogFooter className="pt-0">
            <Button
              type="button"
              variant="outline"
              onClick={() => setRenameOpen(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={!renameTitle.trim()}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </Dialog>

      <Dialog
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        size="md"
        // The header stays put; only the session list scrolls.
        className="flex max-h-[min(50rem,86vh)] flex-col overflow-hidden"
      >
        <DialogHeader className="shrink-0 border-b border-neutral-200">
          <DialogTitle className="flex items-center gap-2 font-semibold">
            <ClockIcon className="size-4.5 shrink-0" />
            Chat History
          </DialogTitle>
        </DialogHeader>
        <DialogContent className="min-h-0 flex-1 p-0">
          <OverlayScrollArea
            className="min-h-0 flex-1"
            contentClassName="px-6 py-4"
          >
            <div ref={historyListRef} class="space-y-2">
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
                    onClick={() =>
                      void confirmDeleteChat(
                        session.id,
                        session.title || "New Chat",
                        true
                      )
                    }
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
          </OverlayScrollArea>
        </DialogContent>
      </Dialog>
    </>
  );
}
