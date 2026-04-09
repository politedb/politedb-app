import { useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { CopyIcon, CopyCheck } from "src/components/icons";
import type { ChatMessage } from "src/types";
import { cellToString } from "src/utils/convert";

type Props = {
  message: ChatMessage;
  onInsertSql?: (sql: string) => Promise<void> | void;
};

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

export function AiAssistantMessageCard({ message, onInsertSql }: Props) {
  const [copied, setCopied] = useState(false);
  const previewColumns = getPreviewColumns(message.resultPreview);
  const messageTime = formatMessageTime(message.createdAt);
  const durationText = message.role === "assistant"
    ? formatDuration(message.durationMs)
    : "";

  const handleCopySql = async () => {
    if (!message.sql) return;
    await navigator.clipboard.writeText(message.sql);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div
      class={`rounded-xl border p-3 ${
        message.role === "user"
          ? "border-blue-200 bg-blue-50"
          : "border-neutral-200 bg-white"
      }`}
    >
      <div class="mb-1 flex items-center justify-between gap-2 text-xs font-bold tracking-wide text-neutral-500 uppercase">
        <span>{message.role === "user" ? "You" : "PoliteDB AI"}</span>
        {messageTime ? (
          <span class="text-[10px] font-medium tracking-normal normal-case text-neutral-400">
            {messageTime}
          </span>
        ) : null}
      </div>
      {durationText ? (
        <div class="mb-2 text-[11px] font-medium text-neutral-400">
          {durationText}
        </div>
      ) : null}

      <div class="text-sm wrap-break-word whitespace-pre-wrap text-neutral-800">
        {message.text}
      </div>

      {message.clarification ? (
        <div class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          {message.clarification}
        </div>
      ) : null}

      {message.sql ? (
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
                <CopyCheck className="size-3.5 text-green-300" />
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
          <div class="mb-1 text-xs font-semibold text-neutral-500">Result</div>
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
  );
}
