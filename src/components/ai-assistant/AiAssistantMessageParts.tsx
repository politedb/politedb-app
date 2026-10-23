import type { ComponentChildren } from "preact";
import { MarkdownText } from "./MarkdownText";
import { ProBadge } from "src/components/license/ProBadge";
import { Button } from "src/components/common/Button";
import { CheckMarkIcon, CopyIcon } from "src/components/icons";
import type { AgentStepSummary, ChatMessage } from "src/types";
import { cellToString } from "src/utils/convert";
import { cn } from "src/utils/cn";
import { OverlayScrollArea } from "src/components/common/OverlayScrollArea";

export type SqlRunState = "idle" | "running" | "done" | "inserted" | "error";
/** What happened to one SQL block's Run or Insert. */
export type SqlRun = { state: SqlRunState; message: string };

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
        aria-label={copied ? "Copied" : "Copy message"}
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
        aria-label={copied ? "Copied" : "Copy SQL"}
        // Shown on hover, and whenever it has keyboard focus.
        class={cn(
          "absolute top-2 right-2 z-10 rounded-md opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          "border border-neutral-700 bg-neutral-900/80 p-1 text-neutral-200 transition hover:bg-neutral-800 hover:text-white"
        )}
      >
        {copied ? (
          <CheckMarkIcon className="size-3.5 text-green-300" />
        ) : (
          <CopyIcon className="size-3.5" />
        )}
      </button>
      <OverlayScrollArea
        className="max-h-56 max-w-full rounded-lg bg-neutral-800"
        contentClassName="p-3 pr-10 text-xs wrap-anywhere whitespace-pre-wrap text-neutral-100"
        horizontal
        vertical
      >
        <code class="wrap-anywhere whitespace-pre-wrap">{sql}</code>
      </OverlayScrollArea>
    </div>
  );
}

function SqlPreviewPart(props: {
  part: Extract<
    NonNullable<ChatMessage["parts"]>[number],
    { type: "sqlPreview" }
  >;
  copied: boolean;
  run?: SqlRun;
  onCopySql: (sql: string) => void;
  onInsert?: (sql: string) => void;
  onRun?: (sql: string, agent: boolean) => void;
  /** This block's query result, when it was the last one run in the message. */
  result?: ComponentChildren;
}) {
  const { part, copied, run, onCopySql, onInsert, onRun, result } = props;
  const sqlRunState = run?.state ?? "idle";
  const sqlRunMessage = run?.message ?? "";

  return (
    <div class="w-full min-w-0 overflow-hidden rounded-lg border border-neutral-200 bg-neutral-50 p-2">
      <div class="mb-1 flex flex-wrap items-center justify-between gap-2 text-xs font-semibold text-neutral-500">
        <span class="min-w-0 truncate">
          SQL Preview
          {part.safety ? ` • ${part.safety.replace("_", " ")}` : ""}
        </span>
        <div class="flex shrink-0 items-center gap-1">
          {onRun && part.safety === "read_only" ? (
            <Button
              variant="default"
              class="px-2 py-1 text-xs"
              loading={sqlRunState === "running"}
              onClick={() => onRun(part.sql, part.agent === true)}
            >
              Run
            </Button>
          ) : null}
          {onInsert ? (
            <Button
              variant="default"
              class="px-2 py-1 text-xs"
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
      {result}
    </div>
  );
}

/**
 * The SQL part a message's result belongs under, or null to show it at the end.
 * Saved chats come from disk, so the stored index is checked, not trusted.
 */
export function resultPartIndexOf(message: ChatMessage): number | null {
  const index = message.resultPartIndex;
  if (typeof index !== "number" || !Number.isInteger(index)) return null;
  return message.parts?.[index]?.type === "sqlPreview" ? index : null;
}

function MessageParts(props: {
  message: ChatMessage;
  /** SQL parts that show a copied tick (by index; -1 is a legacy block). */
  copiedIndexes: Record<number, unknown>;
  sqlRuns: Record<number, SqlRun>;
  onCopySql: (sql: string, index: number) => void;
  onInsert?: (sql: string, index: number) => void;
  onRun?: (sql: string, agent: boolean, index: number) => void;
  onDataAccess?: (allow: boolean, question: string) => void;
  dataAccessSaving?: boolean;
}) {
  const {
    message,
    copiedIndexes,
    sqlRuns,
    onCopySql,
    onInsert,
    onRun,
    onDataAccess,
    dataAccessSaving,
  } = props;
  const resultIndex = resultPartIndexOf(message);

  return (
    <div class="max-w-full min-w-0 space-y-3">
      {message.parts!.map((part, index) => {
        if (part.type === "text") {
          const textClass = "max-w-full min-w-0 text-inherit";
          return message.role === "assistant" ? (
            <MarkdownText
              key={`${message.id}-part-${index}`}
              text={part.text}
              class={textClass}
            />
          ) : (
            <div
              key={`${message.id}-part-${index}`}
              class={cn(textClass, "wrap-break-word whitespace-pre-wrap")}
            >
              {part.text}
            </div>
          );
        }

        if (part.type === "sqlPreview") {
          return (
            <SqlPreviewPart
              key={`${message.id}-part-${index}`}
              part={part}
              copied={index in copiedIndexes}
              run={sqlRuns[index]}
              onCopySql={(sql) => onCopySql(sql, index)}
              onInsert={onInsert ? (sql) => onInsert(sql, index) : undefined}
              onRun={
                onRun ? (sql, agent) => onRun(sql, agent, index) : undefined
              }
              result={
                resultIndex === index ? (
                  <ResultPreviewBlock message={message} />
                ) : null
              }
            />
          );
        }

        if (part.type === "dataAccessRequest") {
          return (
            <DataAccessRequestPart
              key={`${message.id}-part-${index}`}
              label={part.label}
              state={part.state ?? "pending"}
              saving={dataAccessSaving}
              onAnswer={
                onDataAccess
                  ? (allow) => onDataAccess(allow, part.question)
                  : undefined
              }
            />
          );
        }

        if (part.type === "agentSteps") {
          return (
            <AgentStepsPart
              key={`${message.id}-part-${index}`}
              steps={part.steps}
            />
          );
        }

        if (part.type === "error") {
          return (
            <div
              key={`${message.id}-part-${index}`}
              class="max-w-full min-w-0 rounded-lg border border-red-200 bg-red-50 p-2 text-sm wrap-break-word whitespace-pre-wrap text-red-700"
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
  onInsertSql?: (sql: string) => void;
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
              onClick={() => onInsertSql(message.sql!)}
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

function ResultPreviewBlock(props: { message: ChatMessage }) {
  const { message } = props;
  if (!message.resultPreview?.length) return null;
  const previewColumns = getPreviewColumns(message.resultPreview);

  return (
    <div class="mt-3 w-full max-w-full min-w-0 overflow-hidden">
      <div class="mb-1 min-w-0">
        <div class="text-xs font-semibold text-neutral-500">Result</div>
        <div class="text-xs text-neutral-500">
          {message.rowCount != null
            ? `${message.rowCount} row(s)`
            : "Result preview"}
          {message.confidence ? ` • confidence ${message.confidence}` : ""}
        </div>
      </div>

      {/* One card per row: fits the narrow chat at any column count. */}
      {previewColumns.length ? (
        <OverlayScrollArea className="max-h-72 w-full min-w-0 rounded-lg border border-neutral-200 bg-white">
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
        </OverlayScrollArea>
      ) : null}

      <details class="mt-2">
        <summary class="cursor-pointer text-xs text-neutral-500 hover:text-neutral-700">
          View raw JSON
        </summary>
        <OverlayScrollArea
          className="mt-2 max-h-56 rounded-lg bg-neutral-100"
          contentClassName="p-3 text-xs text-neutral-800"
          horizontal
          vertical
        >
          <code>{prettyJson(message.resultPreview)}</code>
        </OverlayScrollArea>
      </details>
    </div>
  );
}

export function AiAssistantMessageBody(props: {
  message: ChatMessage;
  hasParts: boolean;
  isStreamingEmpty: boolean;
  /** SQL parts that show a copied tick (by index; -1 is the legacy `message.sql` block). */
  copiedIndexes: Record<number, unknown>;
  sqlRuns: Record<number, SqlRun>;
  onInsertSql?: (sql: string, index: number) => void;
  onCopySql: (sql: string, index: number) => void;
  onRunSqlPreview?: (sql: string, agent: boolean, index: number) => void;
  onDataAccess?: (allow: boolean, question: string) => void;
  dataAccessSaving?: boolean;
}) {
  const {
    message,
    hasParts,
    isStreamingEmpty,
    copiedIndexes,
    sqlRuns,
    onInsertSql,
    onCopySql,
    onRunSqlPreview,
    onDataAccess,
    dataAccessSaving,
  } = props;
  // A result run from a SQL part shows under that part; any other one at the end.
  const resultInPart = hasParts && resultPartIndexOf(message) !== null;

  return (
    <>
      {isStreamingEmpty ? (
        <AssistantStreamingPlaceholder />
      ) : !hasParts && message.role === "assistant" ? (
        <MarkdownText
          text={message.text}
          class="max-w-full min-w-0 text-inherit"
        />
      ) : !hasParts ? (
        <div class="max-w-full min-w-0 wrap-break-word whitespace-pre-wrap text-inherit">
          {message.text}
        </div>
      ) : null}

      {hasParts ? (
        <MessageParts
          message={message}
          copiedIndexes={copiedIndexes}
          sqlRuns={sqlRuns}
          onCopySql={onCopySql}
          onInsert={onInsertSql}
          onRun={onRunSqlPreview}
          onDataAccess={onDataAccess}
          dataAccessSaving={dataAccessSaving}
        />
      ) : null}

      {!hasParts ? (
        <LegacySqlBlock
          message={message}
          copied={(-1) in copiedIndexes}
          onInsertSql={onInsertSql ? (sql) => onInsertSql(sql, -1) : undefined}
          onCopySql={() => message.sql && onCopySql(message.sql, -1)}
        />
      ) : null}

      {resultInPart ? null : <ResultPreviewBlock message={message} />}

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

/** Fixed labels for agent tools; anything unknown gets a generic one. */
const AGENT_STEP_LABELS: Record<string, string> = {
  list_schemas: "Listed schemas",
  list_tables: "Listed tables",
  describe_table: "Looked at a table's structure",
  sample_rows: "Read sample rows",
  run_readonly_query: "Ran a read-only query",
  explain_query: "Checked a query plan",
};

/**
 * Asks once per connection whether the AI may read its data (plan ai-agent R5).
 * Only fixed, locally built text: the label is the saved connection name.
 */
export function DataAccessRequestPart(props: {
  label?: string;
  state: "pending" | "allowed" | "declined";
  /** The permission is being saved: no second answer. */
  saving?: boolean;
  onAnswer?: (allow: boolean) => void;
}) {
  const { label, state, saving, onAnswer } = props;
  const name = label || "this connection";
  return (
    <div class="w-full min-w-0 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
      <div class="font-medium">Allow AI to read data from {name}?</div>
      <p class="mt-1 text-xs text-amber-900">
        Query results from this connection will be sent to the selected AI
        provider. Data queries are read-only; in safe and production mode each
        one asks for Touch ID or your password.
      </p>
      {state === "pending" && onAnswer ? (
        <div class="mt-2 flex gap-2">
          <Button
            variant="primary"
            class="px-2 py-1 text-xs"
            disabled={saving}
            loading={saving}
            onClick={() => onAnswer(true)}
          >
            Allow
            <span aria-hidden="true">
              <ProBadge className="bg-white/20 text-white" />
            </span>
          </Button>
          <Button
            variant="ghost"
            class="px-2 py-1 text-xs"
            disabled={saving}
            onClick={() => onAnswer(false)}
          >
            Not now
          </Button>
        </div>
      ) : (
        <div class="mt-2 text-xs text-amber-800">
          {state === "allowed"
            ? "Allowed."
            : state === "declined"
              ? "Not allowed."
              : ""}
        </div>
      )}
    </div>
  );
}

/** What an agent run looked at, collapsed by default (plan ai-agent R6). */
export function AgentStepsPart(props: { steps: AgentStepSummary[] }) {
  const { steps } = props;
  if (!steps.length) return null;
  return (
    <details class="group/steps text-[11px] text-neutral-500">
      <summary class="cursor-pointer list-none select-none hover:text-neutral-700">
        <span class="mr-1 inline-block transition group-open/steps:rotate-90">
          ›
        </span>
        Checked the database ({steps.length}{" "}
        {steps.length === 1 ? "step" : "steps"})
      </summary>
      <ol class="mt-1 space-y-0.5 pl-4">
        {steps.map((step, index) => (
          <li key={index} class={step.ok ? undefined : "text-amber-700"}>
            {AGENT_STEP_LABELS[step.tool] ?? "Used a database tool"}
            {step.ok ? "" : " (failed)"}
            {step.truncated ? " (partial)" : ""}
          </li>
        ))}
      </ol>
    </details>
  );
}
