import type { Ref } from "preact";
import { AiAssistantMessageCard } from "src/components/ai-assistant/AiAssistantMessageCard";
import { AiAssistantThinkingCard } from "src/components/ai-assistant/AiAssistantThinkingCard";
import { Button } from "src/components/common/Button";
import { ChevronDownIcon } from "src/components/icons";
import type { AssistantStatus } from "src/components/ai-assistant/hooks/useAiAssistantSubmit";
import type { ChatMessage } from "src/types";

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
  } = props;

  return (
    <>
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
          class="absolute right-4 bottom-42 z-10 rounded-full border border-neutral-200 bg-white p-2 text-neutral-600 shadow-md transition-colors hover:bg-neutral-50 hover:text-neutral-900"
        >
          <ChevronDownIcon className="size-4" />
        </button>
      ) : null}

      <div class="shrink-0 border-t border-neutral-200 px-3 py-3">
        <div class="space-y-2">
          <textarea
            value={prompt}
            onInput={(e) => onPromptChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void onSubmit();
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
              onClick={submitting ? onCancelSubmit : onSubmit}
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
    </>
  );
}
