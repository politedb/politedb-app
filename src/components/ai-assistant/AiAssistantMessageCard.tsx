import { memo } from "preact/compat";
import { useState } from "preact/hooks";
import { isReadOnlySql, queryResultToObjects } from "src/lib/ai-assistant";
import type { QuerySafetyMode } from "src/lib/queries/querySafety";
import { aiAgentSqlSafety } from "src/lib/tauri/aiAgent";
import { runSqlQuery } from "src/lib/tauri/query";
import { securityTouchIdAuthenticate } from "src/lib/tauri/security";
import type { ChatMessage } from "src/types";
import {
  AiAssistantMessageBody,
  AssistantStreamingPlaceholder,
  MessageHoverActions,
  type SqlRun,
} from "./AiAssistantMessageParts";

type AssistantStreamStatus = "loading_model" | "thinking";

type Props = {
  message: ChatMessage;
  streamStatus?: AssistantStreamStatus;
  onInsertSql?: (sql: string) => Promise<void> | void;
  runtimeConnectionId?: string;
  querySafetyMode?: QuerySafetyMode;
  onUpdateMessage?: (id: string, patch: Partial<ChatMessage>) => void;
  /**
   * Grants data access for the current connection and asks `question` again; resolves
   * `false` when the permission could not be saved.
   */
  onAllowDataAccess?: (question: string) => Promise<boolean>;
};

export { AssistantStreamingPlaceholder };

let copyTokenSeq = 0;

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

/**
 * Memoized: while an answer streams, only the streaming message changes, so the
 * other cards skip re-rendering (callers pass stable callbacks).
 */
export const AiAssistantMessageCard = memo(function AiAssistantMessageCard({
  message,
  onInsertSql,
  runtimeConnectionId,
  querySafetyMode = "default",
  onUpdateMessage,
  onAllowDataAccess,
}: Props) {
  // Per SQL preview part (by index; -1 is a legacy `message.sql` block).
  // Copied ticks, each with the token of the copy that set it.
  const [copiedTokens, setCopiedTokens] = useState<Record<number, number>>({});
  const [sqlRuns, setSqlRuns] = useState<Record<number, SqlRun>>({});
  const [dataAccessSaving, setDataAccessSaving] = useState(false);
  const [messageCopied, setMessageCopied] = useState(false);
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
  const isUser = message.role === "user";

  const setSqlRun = (index: number, run: SqlRun) =>
    setSqlRuns((runs) => ({ ...runs, [index]: run }));

  const handleCopySql = async (sql: string, index: number) => {
    await navigator.clipboard.writeText(sql);
    const token = ++copyTokenSeq;
    setCopiedTokens((tokens) => ({ ...tokens, [index]: token }));
    // Only the latest copy of this block clears its tick.
    window.setTimeout(
      () =>
        setCopiedTokens((tokens) => {
          if (tokens[index] !== token) return tokens;
          const { [index]: _done, ...rest } = tokens;
          return rest;
        }),
      1500
    );
  };

  const handleCopyMessage = async () => {
    const text = messageText(message).trim();
    await navigator.clipboard.writeText(text || message.text || "");
    setMessageCopied(true);
    window.setTimeout(() => setMessageCopied(false), 1500);
  };

  const handleInsertSql = async (sql: string, index: number) => {
    if (!onInsertSql) return;
    try {
      await onInsertSql(sql);
      setSqlRun(index, {
        state: "inserted",
        message:
          "Inserted into SQL editor. Run it from the editor to apply the current safety policy.",
      });
    } catch (error) {
      setSqlRun(index, {
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const handleRunSql = async (sql: string, agent: boolean, index: number) => {
    if (!runtimeConnectionId || !isReadOnlySql(sql)) return;

    setSqlRun(index, { state: "running", message: "" });
    try {
      if (querySafetyMode === "safe" || querySafetyMode === "production") {
        await securityTouchIdAuthenticate(
          querySafetyMode === "production"
            ? "Authenticate with Touch ID before reading production data."
            : "Authenticate with Touch ID before sending queries."
        );
      }
      // The label on an agent preview reflects the catalog when it was answered;
      // re-check this SQL on the current connection right before running it.
      if (
        agent &&
        (await aiAgentSqlSafety(sql, runtimeConnectionId)) !== "read_only"
      ) {
        setSqlRun(index, {
          state: "error",
          message:
            "This query can no longer be run from the assistant. Insert it into the SQL editor to review and run it there.",
        });
        return;
      }
      const result = await runSqlQuery(runtimeConnectionId, sql, {
        maxRows: 100,
      });
      const rows = queryResultToObjects(result, 100);
      // One result per message, shown under the SQL that produced it.
      onUpdateMessage?.(message.id, {
        resultPreview: rows,
        rowCount: result.rowCount,
        resultPartIndex: index,
      });
      setSqlRun(index, {
        state: "done",
        message: rows.length ? "" : "Query completed with no rows.",
      });
    } catch (error) {
      setSqlRun(index, {
        state: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return (
    <div
      class={
        isUser
          ? "group ml-auto flex w-fit max-w-[72%] flex-col items-end"
          : "group flex w-full max-w-full min-w-0 flex-col items-start space-y-3 overflow-hidden"
      }
    >
      {/* While streaming the body shows "Thinking..."; afterwards only how long it
          took. No chevron: there is nothing to expand (thinking text is not kept). */}
      {!isUser && durationText ? (
        <div class="text-sm font-medium text-neutral-500">{durationText}</div>
      ) : null}

      {isUser ? (
        <MessageHoverActions
          messageTime={messageTime}
          copied={messageCopied}
          iconClassName="size-5"
          className="mb-1 flex items-center justify-end gap-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          onCopy={() => void handleCopyMessage()}
        />
      ) : null}

      <div
        class={
          isUser
            ? "max-w-full rounded-2xl bg-neutral-200 px-4 py-2 text-base leading-relaxed text-neutral-900"
            : "w-full min-w-0 overflow-hidden text-base leading-relaxed text-neutral-900"
        }
      >
        <AiAssistantMessageBody
          message={message}
          hasParts={hasParts}
          isStreamingEmpty={isStreamingEmpty}
          copiedIndexes={copiedTokens}
          sqlRuns={sqlRuns}
          onInsertSql={
            onInsertSql
              ? (sql, index) => void handleInsertSql(sql, index)
              : undefined
          }
          onCopySql={(sql, index) => void handleCopySql(sql, index)}
          dataAccessSaving={dataAccessSaving}
          onDataAccess={(allow, question) => {
            if (dataAccessSaving) return;
            const mark = (state: "allowed" | "declined") =>
              onUpdateMessage?.(message.id, {
                parts: message.parts?.map((part) =>
                  part.type === "dataAccessRequest" ? { ...part, state } : part
                ),
              });
            if (!allow) {
              mark("declined");
              return;
            }
            // Shown as allowed only once the permission is saved.
            setDataAccessSaving(true);
            void (onAllowDataAccess?.(question) ?? Promise.resolve(false))
              .then((saved) => {
                if (saved) mark("allowed");
              })
              .finally(() => setDataAccessSaving(false));
          }}
          onRunSqlPreview={
            runtimeConnectionId
              ? (sql, agent, index) => void handleRunSql(sql, agent, index)
              : undefined
          }
        />
      </div>

      {!isUser ? (
        <MessageHoverActions
          messageTime={messageTime}
          copied={messageCopied}
          iconClassName="size-5"
          className="flex items-center gap-2 text-neutral-500 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
          onCopy={() => void handleCopyMessage()}
        />
      ) : null}
    </div>
  );
});
