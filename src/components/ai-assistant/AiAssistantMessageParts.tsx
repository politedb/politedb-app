import { useRef } from "preact/hooks";
import { Button } from "src/components/common/Button";
import {
  CheckMarkIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
} from "src/components/icons";
import type { ChatMessage } from "src/types";
import { cellToString } from "src/utils/convert";
import { cn } from "src/utils/cn";

export type SqlRunState = "idle" | "running" | "done" | "inserted" | "error";

export function AssistantStreamingPlaceholder() {
  return (
    <div class="space-y-3" aria-busy="true" aria-live="polite">
      <div class="flex items-center gap-2 text-sm text-neutral-700">
        <span class="gradient-to-r animate-pulse from-neutral-300 to-neutral-600 font-medium">
          Thinking...
        </span>
      </div>
    </div>
  );
}

export function MessageHoverActions(props: {
  messageTime: string;
  copied: boolean;
  iconClassName: string;
  className: string;
  onCopy: () => void;
}) {
  const { messageTime, copied, iconClassName, className, onCopy } = props;

  return (
    <div class={className}>
      {messageTime ? (
        <span class="text-xs font-medium text-neutral-400">{messageTime}</span>
      ) : null}
      <button
        type="button"
        class="rounded-md p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
        title={copied ? "Copied!" : "Copy message"}
        onClick={onCopy}
      >
        {copied ? (
          <CheckMarkIcon className={iconClassName} />
        ) : (
          <CopyIcon className={iconClassName} />
        )}
      </button>
    </div>
  );
}

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

export function getPreviewColumns(rows: Record<string, unknown>[] = []) {
  const seen = new Set<string>();
  for (const row of rows) {
    Object.keys(row ?? {}).forEach((key) => seen.add(key));
  }
  return Array.from(seen);
}

function SqlCodeBlock(props: {
  sql: string;
  copied: boolean;
  onCopy: () => void;
}) {
  const { sql, copied, onCopy } = props;

  return (
    <div class="group relative max-w-full min-w-0">
      <button
        type="button"
        onClick={onCopy}
        title={copied ? "Copied!" : "Copy SQL"}
        class={cn(
          "absolute top-2 right-2 z-10 hidden rounded-md",
          "border border-neutral-700 bg-neutral-900/80 p-1 text-neutral-200 transition-colors group-hover:block hover:bg-neutral-800 hover:text-white"
        )}
      >
        {copied ? (
          <CheckMarkIcon className="size-3.5 text-green-300" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
      <pre class="max-h-56 max-w-full overflow-y-auto rounded-lg bg-neutral-800 p-3 pr-10 text-xs wrap-anywhere whitespace-pre-wrap text-neutral-100">
        <code class="wrap-anywhere whitespace-pre-wrap">{sql}</code>
      </pre>
    </div>
  );
}

function SqlPreviewPart(props: {
  messageId: string;
  partIndex: number;
  part: Extract<
    NonNullable<ChatMessage["parts"]>[number],
    { type: "sqlPreview" }
  >;
  copied: boolean;
  sqlRunState: SqlRunState;
  sqlRunMessage: string;
  onInsertSql?: (sql: string) => Promise<void> | void;
  onCopySql: (sql: string) => void;
  onInsert: (sql: string) => void;
  onRun?: (sql: string) => void;
}) {
  const {
    messageId,
    partIndex,
    part,
    copied,
    sqlRunState,
    sqlRunMessage,
    onInsertSql,
    onCopySql,
    onInsert,
    onRun,
  } = props;

  return (
    <div
      key={`${messageId}-part-${partIndex}`}
      class="w-full min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 p-2"
    >
      <div class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-neutral-500">
        <span class="min-w-0 truncate">
          SQL Preview
          {part.safety ? ` • ${part.safety.replace("_", " ")}` : ""}
        </span>
        <div class="flex shrink-0 items-center gap-1">
          {onRun && part.safety === "read_only" ? (
            <Button
              variant="default"
              class="px-2 py-1"
              loading={sqlRunState === "running"}
              onClick={() => onRun(part.sql)}
            >
              Run
            </Button>
          ) : null}
          {onInsertSql ? (
            <Button
              variant="default"
              class="px-2 py-1"
              onClick={() => onInsert(part.sql)}
            >
              Insert
            </Button>
          ) : null}
        </div>
      </div>
      <SqlCodeBlock
        sql={part.sql}
        copied={copied}
        onCopy={() => onCopySql(part.sql)}
      />
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
    </div>
  );
}

function MessageParts(props: {
  message: ChatMessage;
  floating: boolean;
  copied: boolean;
  sqlRunState: SqlRunState;
  sqlRunMessage: string;
  onInsertSql?: (sql: string) => Promise<void> | void;
  onCopySql: (sql: string) => void;
  onInsert: (sql: string) => void;
  onRun?: (sql: string) => void;
}) {
  const {
    message,
    floating,
    copied,
    sqlRunState,
    sqlRunMessage,
    onInsertSql,
    onCopySql,
    onInsert,
    onRun,
  } = props;

  return (
    <div class="max-w-full min-w-0 space-y-3">
      {message.parts!.map((part, index) => {
        if (part.type === "text") {
          return (
            <div
              key={`${message.id}-part-${index}`}
              class={`max-w-full min-w-0 break-all whitespace-pre-wrap ${
                floating ? "text-inherit" : "text-sm text-neutral-800"
              }`}
            >
              {part.text}
            </div>
          );
        }

        if (part.type === "sqlPreview") {
          return (
            <SqlPreviewPart
              key={`${message.id}-part-${index}`}
              messageId={message.id}
              partIndex={index}
              part={part}
              copied={copied}
              sqlRunState={sqlRunState}
              sqlRunMessage={sqlRunMessage}
              onInsertSql={onInsertSql}
              onCopySql={onCopySql}
              onInsert={onInsert}
              onRun={onRun}
            />
          );
        }

        if (part.type === "error") {
          return (
            <div
              key={`${message.id}-part-${index}`}
              class="max-w-full min-w-0 rounded-lg border border-red-200 bg-red-50 p-2 text-sm break-all whitespace-pre-wrap text-red-700"
            >
              {part.message}
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}

function LegacySqlBlock(props: {
  message: ChatMessage;
  copied: boolean;
  onInsertSql?: (sql: string) => Promise<void> | void;
  onCopySql: () => void;
}) {
  const { message, copied, onInsertSql, onCopySql } = props;
  if (!message.sql) return null;

  return (
    <div class="mt-3 max-w-full overflow-hidden">
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
      <SqlCodeBlock sql={message.sql} copied={copied} onCopy={onCopySql} />
    </div>
  );
}

function ResultPreviewBlock(props: {
  message: ChatMessage;
  previewColumns: string[];
  compact?: boolean;
}) {
  const { message, previewColumns, compact = false } = props;
  const tableScrollRef = useRef<HTMLDivElement>(null);
  if (!message.resultPreview?.length) return null;

  const scrollTable = (direction: -1 | 1) => {
    tableScrollRef.current?.scrollBy({
      left: direction * 240,
      behavior: "smooth",
    });
  };

  return (
    <div class="mt-3 w-full max-w-full min-w-0 overflow-hidden">
      <div class="mb-1 flex min-w-0 items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-xs font-semibold text-neutral-500">Result</div>
          <div class="text-xs text-neutral-500">
            {message.rowCount != null
              ? `${message.rowCount} row(s)`
              : "Result preview"}
            {message.confidence ? ` • confidence ${message.confidence}` : ""}
          </div>
        </div>
        {previewColumns.length > 2 ? (
          <div class="flex shrink-0 items-center gap-1">
            <button
              type="button"
              class="rounded border border-neutral-200 bg-white p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
              title="Previous columns"
              aria-label="Previous result columns"
              onClick={() => scrollTable(-1)}
            >
              <ChevronLeftIcon className="size-3.5" />
            </button>
            <button
              type="button"
              class="rounded border border-neutral-200 bg-white p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
              title="Next columns"
              aria-label="Next result columns"
              onClick={() => scrollTable(1)}
            >
              <ChevronRightIcon className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>

      {previewColumns.length && compact ? (
        <div class="max-h-72 w-full min-w-0 overflow-y-auto rounded-lg border border-neutral-200 bg-white">
          {message.resultPreview.map((row, rowIndex) => (
            <div
              key={`${message.id}-compact-row-${rowIndex}`}
              class="min-w-0 border-b border-neutral-200 p-2 last:border-b-0"
            >
              <div class="mb-1 text-[11px] font-semibold text-neutral-400">
                Row {rowIndex + 1}
              </div>
              <dl class="min-w-0 divide-y divide-neutral-100">
                {previewColumns.map((column) => (
                  <div
                    key={`${message.id}-compact-${rowIndex}-${column}`}
                    class="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)] gap-2 py-1.5 text-xs"
                  >
                    <dt
                      class="min-w-0 truncate font-medium text-neutral-500"
                      title={column}
                    >
                      {column}
                    </dt>
                    <dd
                      class="min-w-0 wrap-anywhere whitespace-pre-wrap text-neutral-800"
                      title={cellToString(row[column]) ?? ""}
                    >
                      {cellToString(row[column])}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>
      ) : previewColumns.length ? (
        <div class="w-full max-w-full min-w-0 overflow-hidden rounded-lg border border-neutral-200">
          <div
            ref={tableScrollRef}
            class="ai-result-scrollbar max-h-56 w-full overflow-auto"
          >
            <table class="w-max min-w-full divide-y divide-neutral-200 text-xs">
              <thead class="sticky top-0 bg-neutral-50">
                <tr>
                  {previewColumns.map((column) => (
                    <th
                      key={`${message.id}-col-${column}`}
                      class="max-w-64 min-w-44 px-3 py-2 text-left font-semibold whitespace-nowrap text-neutral-600"
                    >
                      <div class="max-w-64 truncate" title={column}>
                        {column}
                      </div>
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
                        class="max-w-64 min-w-44 px-3 py-2 align-top text-neutral-800"
                      >
                        <div
                          class="max-w-64 truncate whitespace-nowrap"
                          title={cellToString(row[column]) ?? ""}
                        >
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
  );
}

export function AiAssistantMessageBody(props: {
  message: ChatMessage;
  floating: boolean;
  hasParts: boolean;
  isStreamingEmpty: boolean;
  copied: boolean;
  sqlRunState: SqlRunState;
  sqlRunMessage: string;
  previewColumns: string[];
  onInsertSql?: (sql: string) => Promise<void> | void;
  onCopySql: () => void;
  onCopySqlText: (sql: string) => void;
  onInsertSqlPreview: (sql: string) => void;
  onRunSqlPreview?: (sql: string) => void;
}) {
  const {
    message,
    floating,
    hasParts,
    isStreamingEmpty,
    copied,
    sqlRunState,
    sqlRunMessage,
    previewColumns,
    onInsertSql,
    onCopySql,
    onCopySqlText,
    onInsertSqlPreview,
    onRunSqlPreview,
  } = props;

  return (
    <>
      {isStreamingEmpty ? (
        <AssistantStreamingPlaceholder />
      ) : !hasParts ? (
        <div
          class={`max-w-full min-w-0 break-all whitespace-pre-wrap ${
            floating ? "text-inherit" : "text-sm text-neutral-800"
          }`}
        >
          {message.text}
        </div>
      ) : null}

      {hasParts ? (
        <MessageParts
          message={message}
          floating={floating}
          copied={copied}
          sqlRunState={sqlRunState}
          sqlRunMessage={sqlRunMessage}
          onInsertSql={onInsertSql}
          onCopySql={onCopySqlText}
          onInsert={onInsertSqlPreview}
          onRun={onRunSqlPreview}
        />
      ) : null}

      {message.clarification ? (
        <div class="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-800">
          {message.clarification}
        </div>
      ) : null}

      {!hasParts ? (
        <LegacySqlBlock
          message={message}
          copied={copied}
          onInsertSql={onInsertSql}
          onCopySql={onCopySql}
        />
      ) : null}

      <ResultPreviewBlock
        message={message}
        previewColumns={previewColumns}
        compact={floating}
      />

      {message.assumptions?.length ? (
        <ul class="mt-3 list-disc space-y-1 pl-5 text-sm text-neutral-700">
          {message.assumptions.map((item, index) => (
            <li key={`${message.id}-assumption-${index}`}>{item}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}
