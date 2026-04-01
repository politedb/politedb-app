import { useState } from "preact/hooks";
import { Button } from "src/components/common/Button";
import { Copy, CopyCheck } from "src/components/icons";
import type { ChatMessage } from "src/types";

type Props = {
  message: ChatMessage;
  onInsertSql?: (sql: string) => Promise<void> | void;
};

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function AiAssistantMessageCard({ message, onInsertSql }: Props) {
  const [copied, setCopied] = useState(false);

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
      <div class="mb-1 text-xs font-bold tracking-wide text-neutral-500 uppercase">
        {message.role === "user" ? "You" : "PoliteDB AI"}
      </div>

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
          <div class="relative">
            <button
              type="button"
              onClick={() => void handleCopySql()}
              title={copied ? "Copied!" : "Copy SQL"}
              class="absolute top-2 right-2 z-10 rounded-md border border-neutral-700 bg-neutral-900/80 p-1 text-neutral-200 transition-colors hover:bg-neutral-800 hover:text-white"
            >
              {copied ? (
                <CopyCheck className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
            <pre class="max-h-56 overflow-auto rounded-lg bg-neutral-800 p-3 pr-10 text-xs text-neutral-100">
              <code>{message.sql}</code>
            </pre>
          </div>
        </div>
      ) : null}

      {message.assumptions?.length ? (
        <ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
          {message.assumptions.map((item, index) => (
            <li key={`${message.id}-assumption-${index}`}>{item}</li>
          ))}
        </ul>
      ) : null}

      {message.resultPreview?.length ? (
        <div class="mt-3">
          <div class="mb-1 text-xs text-neutral-500">
            {message.rowCount != null
              ? `${message.rowCount} row(s)`
              : "Result preview"}
            {message.confidence ? ` • confidence ${message.confidence}` : ""}
          </div>
          <pre class="max-h-56 overflow-auto rounded-lg bg-neutral-100 p-3 text-xs text-neutral-800">
            <code>{prettyJson(message.resultPreview)}</code>
          </pre>
        </div>
      ) : null}
    </div>
  );
}
