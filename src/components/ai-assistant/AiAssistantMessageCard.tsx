import { useState } from "preact/hooks";
import { isReadOnlySql, queryResultToObjects } from "src/lib/ai-assistant";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import { runSqlQuery } from "src/lib/tauri/query";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";
import type { ChatMessage } from "src/types";
import {
  AiAssistantMessageBody,
  AssistantStreamingPlaceholder,
  getPreviewColumns,
  MessageHoverActions,
  type SqlRunState,
} from "./AiAssistantMessageParts";

type AssistantStreamStatus = "loading_model" | "thinking";

type Props = {
  message: ChatMessage;
  presentation?: "panel" | "floating";
  streamStatus?: AssistantStreamStatus;
  onInsertSql?: (sql: string) => Promise<void> | void;
  runtimeConnectionId?: string;
  querySafetyMode?: QuerySafetyMode;
  onUpdateMessage?: (id: string, patch: Partial<ChatMessage>) => void;
};

export { AssistantStreamingPlaceholder };

function formatMessageTime(value?: number) {
  if (!value) return "";
  try {
    return new Intl.DateTimeFormat(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "";
  }
}

function formatDuration(value?: number) {
  if (!value || value < 1000) return "";
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `Worked for ${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `Worked for ${minutes}m ${seconds}s`;
  }
  return `Worked for ${seconds}s`;
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

export function AiAssistantMessageCard({
  message,
  presentation = "panel",
  onInsertSql,
  runtimeConnectionId,
  querySafetyMode = "default",
  onUpdateMessage,
}: Props) {
  const [copied, setCopied] = useState(false);
  const [messageCopied, setMessageCopied] = useState(false);
  const [sqlRunState, setSqlRunState] = useState<SqlRunState>("idle");
  const [sqlRunMessage, setSqlRunMessage] = useState("");
  const previewColumns = getPreviewColumns(message.resultPreview);
  const hasParts = (message.parts?.length ?? 0) > 0;
  const messageTime = formatMessageTime(message.createdAt);
  const durationText =
    message.role === "assistant" && !message.streaming
      ? formatDuration(message.durationMs)
      : "";
  const isStreamingEmpty =
    Boolean(message.streaming) &&
    message.role === "assistant" &&
    !message.text.trim();
  const floating = presentation === "floating";
  const floatingAssistant = floating && message.role === "assistant";
  const floatingUser = floating && message.role === "user";

  const handleCopySql = async () => {
    if (!message.sql) return;
    await navigator.clipboard.writeText(message.sql);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleCopySqlText = async (sql: string) => {
    await navigator.clipboard.writeText(sql);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const handleCopyMessage = async () => {
    const text = messageText(message).trim();
    await navigator.clipboard.writeText(text || message.text || "");
    setMessageCopied(true);
    window.setTimeout(() => setMessageCopied(false), 1500);
  };

  const handleInsertSql = async (sql: string) => {
    if (!onInsertSql) return;
    try {
      await onInsertSql(sql);
      setSqlRunState("inserted");
      setSqlRunMessage(
        "Inserted into SQL editor. Run it from the editor to apply the current safety policy."
      );
    } catch (error) {
      setSqlRunState("error");
      setSqlRunMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const handleRunSql = async (sql: string) => {
    if (!runtimeConnectionId || !isReadOnlySql(sql)) return;

    setSqlRunState("running");
    setSqlRunMessage("");
    try {
      if (querySafetyMode === "safe" || querySafetyMode === "production") {
        await securityTouchIdAuthenticate(
          querySafetyMode === "production"
            ? "Authenticate with Touch ID before reading production data."
            : "Authenticate with Touch ID before sending queries."
        );
      }
      const result = await runSqlQuery(runtimeConnectionId, sql, {
        maxRows: 100,
      });
      const rows = queryResultToObjects(result, 100);
      onUpdateMessage?.(message.id, {
        resultPreview: rows,
        rowCount: result.rowCount,
      });
      setSqlRunState("done");
      setSqlRunMessage(rows.length ? "" : "Query completed with no rows.");
    } catch (error) {
      setSqlRunState("error");
      setSqlRunMessage(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div
      class={
        floatingUser
          ? "group ml-auto flex w-fit max-w-[72%] flex-col items-end"
          : floatingAssistant
            ? "group flex w-full max-w-full min-w-0 flex-col items-start space-y-3 overflow-hidden"
            : `group rounded-xl border p-3 ${
                message.role === "user"
                  ? "border-blue-200 bg-blue-50"
                  : "border-neutral-200 bg-white"
              }`
      }
    >
      {!floating ? (
        <>
          <div class="mb-1 flex items-center justify-between gap-2 text-xs font-bold tracking-wide text-neutral-500 uppercase">
            <span>{message.role === "user" ? "You" : "PoliteDB AI"}</span>
            <MessageHoverActions
              messageTime={messageTime}
              copied={messageCopied}
              iconClassName="size-3.5 text-green-600"
              className="flex items-center gap-2 opacity-0 group-hover:opacity-100"
              onCopy={() => void handleCopyMessage()}
            />
          </div>
          {durationText ? (
            <div class="mb-2 text-[11px] font-medium text-neutral-400">
              {durationText}
            </div>
          ) : null}
        </>
      ) : null}

      {floatingAssistant ? (
        <div class="flex items-center gap-2 text-base font-semibold text-neutral-500">
          <span>Thought</span>
          <span class="text-neutral-400">›</span>
        </div>
      ) : null}

      {floatingUser ? (
        <MessageHoverActions
          messageTime={messageTime}
          copied={messageCopied}
          iconClassName="size-5"
          className="mb-1 flex items-center justify-end gap-2 opacity-0 group-hover:opacity-100"
          onCopy={() => void handleCopyMessage()}
        />
      ) : null}

      <div
        class={
          floatingUser
            ? "max-w-full rounded-2xl bg-neutral-100 px-4 py-2 text-base leading-relaxed text-neutral-900"
            : floatingAssistant
              ? "w-full min-w-0 overflow-hidden text-base leading-relaxed text-neutral-900"
              : ""
        }
      >
        <AiAssistantMessageBody
          message={message}
          floating={floating}
          hasParts={hasParts}
          isStreamingEmpty={isStreamingEmpty}
          copied={copied}
          sqlRunState={sqlRunState}
          sqlRunMessage={sqlRunMessage}
          previewColumns={previewColumns}
          onInsertSql={onInsertSql ? handleInsertSql : undefined}
          onCopySql={() => void handleCopySql()}
          onCopySqlText={(sql) => void handleCopySqlText(sql)}
          onInsertSqlPreview={(sql) => void handleInsertSql(sql)}
          onRunSqlPreview={
            runtimeConnectionId ? (sql) => void handleRunSql(sql) : undefined
          }
        />
      </div>

      {floatingAssistant ? (
        <MessageHoverActions
          messageTime={messageTime}
          copied={messageCopied}
          iconClassName="size-5"
          className="flex items-center gap-2 text-neutral-500 opacity-0 group-hover:opacity-100"
          onCopy={() => void handleCopyMessage()}
        />
      ) : null}
    </div>
  );
}
