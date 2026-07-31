import { useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { CopyIcon, CopyCheckIcon } from "src/components/icons";
import type { ChatMessage } from "src/types";
import { cellToString } from "src/utils/convert";

type AssistantStreamStatus = "loading_model" | "thinking";

type Props = {
  message: ChatMessage;
  presentation?: "panel" | "floating";
  streamStatus?: AssistantStreamStatus;
  onInsertSql?: (sql: string) => Promise<void> | void;
  runtimeConnectionId?: string;
};

function AssistantStreamingPlaceholder() {
  return (
    <div class="space-y-3" aria-busy="true" aria-live="polite">
      <div class="flex items-center gap-2 text-xs text-neutral-700">
        <span class="gradient-to-r animate-pulse from-neutral-300 to-neutral-600 font-medium">
          Thinking...
        </span>
      </div>
    </div>
  );
}

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

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function getPreviewColumns(rows: Record<string, unknown>[] = []) {
  const seen = new Set<string>();
  for (const row of rows) {
    Object.keys(row ?? {}).forEach((key) => seen.add(key));
  }
  return Array.from(seen);
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
}: Props) {
  const [copied, setCopied] = useState(false);
  const [messageCopied, setMessageCopied] = useState(false);
  const [sqlRunState, setSqlRunState] = useState<
    "idle" | "inserted" | "canceled" | "error"
  >("idle");
  const [sqlRunMessage, setSqlRunMessage] = useState("");
  const previewColumns = getPreviewColumns(message.resultPreview);
  const hasParts = (message.parts?.length ?? 0) > 0;
  const messageTime = formatMessageTime(message.createdAt);
  const durationText =
    message.role === "assistant" && !message.streaming
      ? formatDuration(message.durationMs)
      : "";
  const isStreamingEmpty =
    message.streaming && message.role === "assistant" && !message.text.trim();
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

  return (
    <div
      class={
        floatingUser
          ? "group flex flex-col items-end"
          : floatingAssistant
            ? "group space-y-4"
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
            <div class="flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
              {messageTime ? (
                <span class="text-[10px] font-medium tracking-normal text-neutral-400 normal-case">
                  {messageTime}
                </span>
              ) : null}
              <button
                type="button"
                class="rounded-md p-0.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
                title={messageCopied ? "Copied!" : "Copy message"}
                onClick={() => void handleCopyMessage()}
              >
                {messageCopied ? (
                  <CopyCheckIcon className="size-3.5 text-green-600" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </button>
            </div>
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
        <div class="mb-1 flex items-center justify-end gap-2 opacity-0 transition-opacity group-hover:opacity-100">
          {messageTime ? (
            <span class="text-xs font-medium text-neutral-400">
              {messageTime}
            </span>
          ) : null}
          <button
            type="button"
            class="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
            title={messageCopied ? "Copied!" : "Copy message"}
            onClick={() => void handleCopyMessage()}
          >
            {messageCopied ? (
              <CopyCheckIcon className="size-4 text-green-600" />
            ) : (
              <CopyIcon className="size-4" />
            )}
          </button>
        </div>
      ) : null}

      <div
        class={
          floatingUser
            ? "max-w-[72%] rounded-full bg-neutral-100 px-4 py-2 text-base leading-relaxed text-neutral-900"
            : floatingAssistant
              ? "text-base leading-relaxed text-neutral-900"
              : ""
        }
      >
        {isStreamingEmpty ? (
          <AssistantStreamingPlaceholder />
        ) : !hasParts ? (
          <div
            class={`wrap-break-word whitespace-pre-wrap ${
              floating ? "text-inherit" : "text-sm text-neutral-800"
            }`}
          >
            {message.text}
          </div>
        ) : null}

        {hasParts ? (
          <div class="space-y-3">
            {message.parts!.map((part, index) => {
              if (part.type === "text") {
                return (
                  <div
                    key={`${message.id}-part-${index}`}
                    class={`wrap-break-word whitespace-pre-wrap ${
                      floating ? "text-inherit" : "text-sm text-neutral-800"
                    }`}
                  >
                    {part.text}
                  </div>
                );
              }

              if (part.type === "sqlPreview") {
                return (
                  <div
                    key={`${message.id}-part-${index}`}
                    class="rounded-lg border border-neutral-200 bg-neutral-50 p-2"
                  >
                    <div class="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-neutral-500">
                      <span>
                        SQL Preview
                        {part.safety
                          ? ` • ${part.safety.replace("_", " ")}`
                          : ""}
                      </span>
                      <div class="flex items-center gap-1">
                        {onInsertSql ? (
                          <Button
                            variant="default"
                            class="px-2 py-1"
                            onClick={() => void handleInsertSql(part.sql)}
                          >
                            Insert
                          </Button>
                        ) : null}
                        <Button
                          variant="ghost"
                          class="px-2 py-1"
                          onClick={() => {
                            setSqlRunState("canceled");
                            setSqlRunMessage("");
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                    {sqlRunState === "canceled" ? (
                      <div class="rounded-md border border-neutral-200 bg-white px-2 py-1 text-xs text-neutral-500">
                        SQL preview canceled.
                      </div>
                    ) : (
                      <>
                        <div class="group relative">
                          <button
                            type="button"
                            onClick={() => void handleCopySqlText(part.sql)}
                            title={copied ? "Copied!" : "Copy SQL"}
                            class="absolute top-2 right-2 z-10 hidden rounded-md border border-neutral-700 bg-neutral-900/80 p-1 text-neutral-200 transition-colors group-hover:block hover:bg-neutral-800 hover:text-white"
                          >
                            {copied ? (
                              <CopyCheckIcon className="size-3.5 text-green-300" />
                            ) : (
                              <CopyIcon className="size-3.5" />
                            )}
                          </button>
                          <pre class="max-h-56 overflow-auto rounded-lg bg-neutral-800 p-3 pr-10 text-xs text-neutral-100">
                            <code>{part.sql}</code>
                          </pre>
                        </div>
                        {sqlRunMessage ? (
                          <div
                            class={`mt-2 rounded-md border px-2 py-1 text-xs ${
                              sqlRunState === "error"
                                ? "border-red-200 bg-red-50 text-red-700"
                                : "border-blue-200 bg-blue-50 text-blue-700"
                            }`}
                          >
                            {sqlRunMessage}
                          </div>
                        ) : null}
                      </>
                    )}
                  </div>
                );
              }

              if (part.type === "error") {
                return (
                  <div
                    key={`${message.id}-part-${index}`}
                    class="rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700"
                  >
                    {part.message}
                  </div>
                );
              }

              return null;
            })}
          </div>
        ) : null}

        {message.clarification ? (
          <div class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
            {message.clarification}
          </div>
        ) : null}

        {!hasParts && message.sql ? (
          <div class="mt-3">
            <div class="mb-1 flex items-center justify-between gap-2 text-xs font-semibold text-neutral-500">
              <span>SQL</span>
              <div class="flex items-center gap-2">
                {onInsertSql ? (
                  <Button
                    variant="default"
                    class="px-2 py-1"
                    onClick={() => void onInsertSql(message.sql!)}
                  >
                    Insert into editor
                  </Button>
                ) : null}
              </div>
            </div>
            <div class="group relative">
              <button
                type="button"
                onClick={() => void handleCopySql()}
                title={copied ? "Copied!" : "Copy SQL"}
                class="absolute top-2 right-2 z-10 hidden rounded-md border border-neutral-700 bg-neutral-900/80 p-1 text-neutral-200 transition-colors group-hover:block hover:bg-neutral-800 hover:text-white"
              >
                {copied ? (
                  <CopyCheckIcon className="size-3.5 text-green-300" />
                ) : (
                  <CopyIcon className="size-3.5" />
                )}
              </button>
              <pre class="max-h-56 overflow-auto rounded-lg bg-neutral-800 p-3 pr-10 text-xs text-neutral-100">
                <code>{message.sql}</code>
              </pre>
            </div>
          </div>
        ) : null}

        {message.resultPreview?.length ? (
          <div class="mt-3">
            <div class="mb-1 text-xs font-semibold text-neutral-500">
              Result
            </div>
            <div class="mb-1 text-xs text-neutral-500">
              {message.rowCount != null
                ? `${message.rowCount} row(s)`
                : "Result preview"}
              {message.confidence ? ` • confidence ${message.confidence}` : ""}
            </div>

            {previewColumns.length ? (
              <div class="overflow-hidden rounded-lg border border-neutral-200">
                <div class="max-h-56 overflow-auto">
                  <table class="min-w-full divide-y divide-neutral-200 text-xs">
                    <thead class="bg-neutral-50">
                      <tr>
                        {previewColumns.map((column) => (
                          <th
                            key={`${message.id}-col-${column}`}
                            class="px-3 py-2 text-left font-semibold text-neutral-600"
                          >
                            {column}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody class="divide-y divide-neutral-100 bg-white">
                      {message.resultPreview.map((row, index) => (
                        <tr key={`${message.id}-row-${index}`}>
                          {previewColumns.map((column) => (
                            <td
                              key={`${message.id}-row-${index}-${column}`}
                              class="max-w-52 px-3 py-2 align-top text-neutral-800"
                            >
                              <div class="line-clamp-4 wrap-break-word whitespace-pre-wrap">
                                {cellToString(row[column])}
                              </div>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            <details class="mt-2">
              <summary class="cursor-pointer text-xs text-neutral-500 hover:text-neutral-700">
                View raw JSON
              </summary>
              <pre class="mt-2 max-h-56 overflow-auto rounded-lg bg-neutral-100 p-3 text-xs text-neutral-800">
                <code>{prettyJson(message.resultPreview)}</code>
              </pre>
            </details>
          </div>
        ) : null}

        {message.assumptions?.length ? (
          <ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
            {message.assumptions.map((item, index) => (
              <li key={`${message.id}-assumption-${index}`}>{item}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {floatingAssistant ? (
        <div class="flex items-center gap-2 text-neutral-500 opacity-0 transition-opacity group-hover:opacity-100">
          {messageTime ? (
            <span class="text-xs font-medium text-neutral-400">
              {messageTime}
            </span>
          ) : null}
          <button
            type="button"
            class="rounded-md p-1 hover:bg-neutral-100 hover:text-neutral-900"
            title={messageCopied ? "Copied!" : "Copy message"}
            onClick={() => void handleCopyMessage()}
          >
            {messageCopied ? (
              <CopyCheckIcon className="size-5 text-green-600" />
            ) : (
              <CopyIcon className="size-5" />
            )}
          </button>
        </div>
      ) : null}
    </div>
  );
}
