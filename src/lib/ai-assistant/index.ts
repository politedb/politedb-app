import type { DatabaseEngine, TableItem } from "src/types";
import type { QueryResult } from "src/lib/tauri";
import {
  AI_ENDPOINT_KEY,
  AI_MODEL_KEY,
  AI_MODEL_SEEN_KEY,
  DEFAULT_AI_SETTINGS,
  MODEL_LOADING_MAX_RETRIES,
  MODEL_LOADING_RETRY_MS,
} from "src/utils/assistant";
import {
  buildChatReplyPrompt,
  buildIntentClassifierPrompt,
  buildResultAnswerPrompt,
  buildSqlPlanPrompt,
} from "@root/src/lib/ai-assistant/prompts";
import type {
  AiAnswer,
  AiChatReply,
  AiHistoryItem,
  AiIntentDecision,
  AiPlan,
  AmbiguousPromptReply,
  DirectMetadataReply,
  GenerateOptions,
  LocalAiSettings,
  ReplyLanguage,
} from "@root/src/lib/ai-assistant/types";

function safeGetLocalStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetLocalStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {}
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function sanitizeAiText(value: unknown) {
  const text = String(value ?? "").trim();
  if (!text) return "";

  const normalized = text.toLowerCase();
  if (
    normalized === "string" ||
    normalized === "answer" ||
    normalized === "followup" ||
    normalized === "clarification" ||
    normalized === "sql" ||
    normalized === "explanation"
  ) {
    return "";
  }

  return text;
}

function sanitizeAiStringArray(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => sanitizeAiText(item)).filter(Boolean);
}

function normalizeIntentText(value: string) {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    const onAbort = () => {
      window.clearTimeout(timeoutId);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }
}

export function getLocalAiSettings(): LocalAiSettings {
  return {
    endpoint:
      safeGetLocalStorage(AI_ENDPOINT_KEY)?.trim() ||
      DEFAULT_AI_SETTINGS.endpoint,
    model:
      safeGetLocalStorage(AI_MODEL_KEY)?.trim() || DEFAULT_AI_SETTINGS.model,
  };
}

export function saveLocalAiSettings(settings: LocalAiSettings) {
  safeSetLocalStorage(AI_ENDPOINT_KEY, settings.endpoint.trim());
  safeSetLocalStorage(AI_MODEL_KEY, settings.model.trim());
}

export function hasSeenLocalAiModel() {
  return safeGetLocalStorage(AI_MODEL_SEEN_KEY) === "1";
}

export function markLocalAiModelSeen() {
  safeSetLocalStorage(AI_MODEL_SEEN_KEY, "1");
}

export async function listLocalAiModels(endpoint: string): Promise<string[]> {
  const base = trimTrailingSlash(endpoint.trim());
  const res = await fetch(`${base}/models`, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    throw new Error(`OLLAMA_TAGS_FAILED: ${res.status} ${res.statusText}`);
  }

  const data = await res.json();
  const models = Array.isArray(data?.data)
    ? data.data
        .map((item: any) => String(item?.id ?? "").trim())
        .filter(Boolean)
    : [];

  return Array.from(new Set(models));
}

function extractJsonObject(text: string) {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("AI returned an empty response.");

  try {
    return JSON.parse(trimmed);
  } catch {}

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first >= 0 && last > first) {
    return JSON.parse(trimmed.slice(first, last + 1));
  }

  throw new Error("AI response was not valid JSON.");
}

async function generateJson<T>(opts: GenerateOptions): Promise<T> {
  const content = await generateText(opts);
  return extractJsonObject(content) as T;
}

async function generateText(opts: GenerateOptions): Promise<string> {
  const endpoint = trimTrailingSlash(opts.endpoint.trim());
  const maxTokens = Math.max(32, Math.min(opts.maxTokens ?? 256, 1024));
  for (let attempt = 0; attempt <= MODEL_LOADING_MAX_RETRIES; attempt++) {
    throwIfAborted(opts.signal);
    opts.onStatusChange?.("generating");
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        model: opts.model.trim(),
        messages: [
          {
            role: "user",
            content: opts.prompt,
          },
        ],
        temperature: 0.1,
        max_tokens: maxTokens,
        stream: false,
      }),
    });

    if (res.ok) {
      const data = await res.json();
      return String(data?.choices?.[0]?.message?.content ?? "").trim();
    }

    const bodyText = await res.text().catch(() => "");
    const details = bodyText.trim().replace(/\s+/g, " ").slice(0, 280);
    const isModelLoading =
      res.status === 503 &&
      /loading model|unavailable_error|server is busy/i.test(details);

    if (isModelLoading && attempt < MODEL_LOADING_MAX_RETRIES) {
      opts.onStatusChange?.("loading_model");
      await sleep(MODEL_LOADING_RETRY_MS, opts.signal);
      continue;
    }

    throw new Error(
      `OLLAMA_GENERATE_FAILED: ${res.status} ${res.statusText}${details ? ` - ${details}` : ""}`
    );
  }

  throw new Error(
    "OLLAMA_GENERATE_FAILED: timed out waiting for model to load"
  );
}

function toSchemaLines(args: {
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  question?: string;
}) {
  const { activeSchema, tables, columnsByTable = {}, question } = args;

  const visibleTables = tables.filter(
    (table) => !activeSchema || table.schema === activeSchema
  );

  if (!visibleTables.length) {
    return "No table metadata is loaded yet.";
  }

  const questionTokens = Array.from(
    new Set(
      (question ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/g)
        .map((item) => item.trim())
        .filter((item) => item.length >= 2)
    )
  );

  const rankedTables = visibleTables
    .map((table) => {
      const key = `${table.schema}.${table.name}`;
      const cols = columnsByTable[key] ?? [];
      const haystack =
        `${table.schema} ${table.name} ${cols.join(" ")}`.toLowerCase();
      const score = questionTokens.reduce(
        (acc, token) => acc + (haystack.includes(token) ? 1 : 0),
        0
      );
      return { table, score };
    })
    .sort(
      (a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name)
    );

  const selectedTables = rankedTables.some((item) => item.score > 0)
    ? rankedTables.slice(0, 24).map((item) => item.table)
    : rankedTables.slice(0, 48).map((item) => item.table);

  return selectedTables
    .map((table) => {
      const key = `${table.schema}.${table.name}`;
      const cols = (columnsByTable[key] ?? []).slice(0, 20);
      const suffix = cols.length
        ? `(${cols.map(formatColumnForAi).join(", ")})`
        : "(columns unknown)";
      return `- ${table.schema}.${table.name} ${suffix}`;
    })
    .join("\n");
}

function toConversationLines(history: AiHistoryItem[] = [], limit = 6) {
  const normalized = history
    .map((item) => ({
      role: item.role,
      text: String(item.text ?? "").trim(),
      sql: String(item.sql ?? "").trim(),
    }))
    .filter((item) => item.text || item.sql)
    .slice(-limit);

  if (!normalized.length) return "No previous conversation.";

  return normalized
    .map((item) => {
      const parts = [
        `${item.role === "assistant" ? "Assistant" : "User"}: ${item.text || "(no text)"}`,
      ];
      if (item.sql) {
        parts.push(`SQL: ${item.sql}`);
      }
      return parts.join("\n");
    })
    .join("\n\n");
}

function detectReplyLanguage(text: string): "english" | "vietnamese" | null {
  const raw = String(text ?? "").trim();
  const normalized = normalizeIntentText(text);
  if (!raw || !normalized) return null;

  if (
    /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(
      raw
    ) ||
    /\b(xin chao|chao|toi|cho toi|giup toi|lay|liet ke|hien thi|dem|du lieu|bang|cot|truy van|schema|co so du lieu)\b/.test(
      normalized
    )
  ) {
    return "vietnamese";
  }

  if (
    /\b(use|speak|answer|reply|respond)( in)? english\b/.test(normalized) ||
    /\benglish please\b/.test(normalized) ||
    /\btieng anh\b/.test(normalized)
  ) {
    return "english";
  }

  if (
    /\b(use|speak|answer|reply|respond)( in)? vietnamese\b/.test(normalized) ||
    /\btieng viet\b/.test(normalized)
  ) {
    return "vietnamese";
  }

  return null;
}

function getPreferredReplyLanguage(
  _question: string,
  _history: AiHistoryItem[] = []
): ReplyLanguage {
  return "english";
}

function detectQuestionLanguage(
  text: string
): "english" | "vietnamese" | "unknown" {
  const detected = detectReplyLanguage(text);
  if (detected === "english" || detected === "vietnamese") {
    return detected;
  }
  return "unknown";
}

function hasDatabaseIntent(text: string) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;

  return [
    /\b(sql|query|table|column|schema|database|db|row|filter|where|join|group by|order by)\b/,
    /\b(select|count|list|show|find|get|top|latest|newest|oldest|compare|trend|sum|avg|average|max|min|duplicate|missing)\b/,
    /\b(liet ke|dem|tim|hien thi|truy van|sap xep|loc|thong ke|so sanh|tong|trung binh|lon nhat|nho nhat|moi nhat)\b/,
  ].some((pattern) => pattern.test(normalized));
}

function countMeaningfulTokens(text: string) {
  return normalizeIntentText(text)
    .split(/[^a-z0-9_]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2).length;
}

export function getAmbiguousPromptReply(args: {
  question: string;
  history?: AiHistoryItem[];
}): AmbiguousPromptReply | null {
  const raw = String(args.question ?? "").trim();
  const text = normalizeIntentText(raw);
  if (!text) return null;

  const meaningfulTokenCount = countMeaningfulTokens(raw);
  const compact = text.replace(/\s+/g, " ").trim();

  const obviouslyVague =
    meaningfulTokenCount === 0 ||
    compact.length <= 3 ||
    /^(a+|b+|c+|d+|e+|h+m+|h+e+l+o*|ok+|oke+|test+|aaa+|bbb+|ccc+)$/.test(
      compact
    ) ||
    /^(gi gi|gi do|cai gi|nao|sao|huh|uh|umm+|hmm+|idk|whatever)$/.test(
      compact
    );

  const tooShortWithoutIntent =
    meaningfulTokenCount <= 1 &&
    !hasDatabaseIntent(raw) &&
    !isGeneralChatPrompt(raw);

  if (!obviouslyVague && !tooShortWithoutIntent) {
    return null;
  }

  return {
    answer: "I am not sure what you want to do with the data yet.",
    followup:
      "Please be more specific, for example: show the latest 10 rows, count records, filter by a condition, or explain a specific SQL query.",
  };
}

export async function classifyAssistantIntent(args: {
  endpoint: string;
  model: string;
  engine: DatabaseEngine;
  question: string;
  activeSchema?: string;
  tables: TableItem[];
  history?: AiHistoryItem[];
  onStatusChange?: (status: "loading_model" | "generating") => void;
  signal?: AbortSignal;
}) {
  const conversationSummary = toConversationLines(args.history);
  const visibleTables = args.tables
    .filter((table) => !args.activeSchema || table.schema === args.activeSchema)
    .slice(0, 16)
    .map((table) => `${table.schema}.${table.name}`)
    .join(", ");

  const prompt = buildIntentClassifierPrompt({
    engine: args.engine,
    activeSchema: args.activeSchema,
    visibleTables,
    conversationSummary,
    question: args.question,
  });

  const raw = await generateJson<Partial<AiIntentDecision>>({
    endpoint: args.endpoint,
    model: args.model,
    prompt,
    maxTokens: 96,
    onStatusChange: args.onStatusChange,
    signal: args.signal,
  });

  const kind =
    raw?.kind === "chat" ||
    raw?.kind === "metadata" ||
    raw?.kind === "sql" ||
    raw?.kind === "clarify"
      ? raw.kind
      : "clarify";

  const questionLanguage =
    raw?.questionLanguage === "english" ||
    raw?.questionLanguage === "vietnamese" ||
    raw?.questionLanguage === "unknown"
      ? raw.questionLanguage
      : detectQuestionLanguage(args.question);
  const replyLanguage = "english";

  return {
    kind,
    questionLanguage,
    replyLanguage,
    clarification: sanitizeAiText(raw?.clarification) || undefined,
  } satisfies AiIntentDecision;
}

function formatListPreview(items: string[], maxItems = 12) {
  if (!items.length) return "";
  if (items.length <= maxItems) return items.join(", ");
  return `${items.slice(0, maxItems).join(", ")} and ${items.length - maxItems} more`;
}

export function getDirectMetadataReply(args: {
  engine: DatabaseEngine;
  question: string;
  activeSchema?: string;
  tables: TableItem[];
}) {
  const text = normalizeIntentText(args.question);
  if (!text) return null;
  const visibleTables = args.tables.filter(
    (table) => !args.activeSchema || table.schema === args.activeSchema
  );
  const visibleNames = visibleTables.map((table) => table.name);
  const schemaNames = Array.from(
    new Set(args.tables.map((table) => table.schema).filter(Boolean))
  );

  const asksAllDatabases =
    /\b(all )?(database|databases|db)\b/.test(text) ||
    /\b(toan bo db|tat ca db|liet ke db|hien thi db)\b/.test(text);
  const asksSchemas =
    /\b(schema|schemas)\b/.test(text) ||
    /\b(so do|liet ke schema|tat ca schema)\b/.test(text);
  const asksTables =
    /\b(table|tables|collection|collections|key|keys)\b/.test(text) ||
    /\b(liet ke bang|tat ca bang|toan bo bang|liet ke collection|liet ke key)\b/.test(
      text
    );
  const asksListLike = [
    /\b(list|show|display|what are|which are|give me)\b/,
    /\b(liet ke|hien thi|cho toi|toan bo|tat ca|common)\b/,
  ].some((pattern) => pattern.test(text));

  if (!asksListLike && !asksAllDatabases && !asksSchemas && !asksTables) {
    return null;
  }

  if (
    args.engine === "redis" &&
    (asksTables || asksAllDatabases || asksSchemas)
  ) {
    return {
      answer: visibleNames.length
        ? `I can currently see ${visibleNames.length} key(s) in db ${args.activeSchema || "0"}: ${formatListPreview(visibleNames)}.`
        : `I do not see any keys in db ${args.activeSchema || "0"} yet.`,
    } satisfies DirectMetadataReply;
  }

  if (
    args.engine === "mongo" &&
    (asksTables || asksAllDatabases || asksSchemas)
  ) {
    return {
      answer: visibleNames.length
        ? `I can currently see ${visibleNames.length} collection(s) in database ${args.activeSchema || "(current)"}: ${formatListPreview(visibleNames)}.`
        : `I do not see any collections in database ${args.activeSchema || "(current)"} yet.`,
    } satisfies DirectMetadataReply;
  }

  if (asksAllDatabases) {
    if (schemaNames.length > 1) {
      return {
        answer: `In the current connection I can see ${schemaNames.length} schema/database name(s): ${formatListPreview(schemaNames)}.`,
        followup:
          visibleNames.length > 0
            ? `For the active scope ${args.activeSchema || schemaNames[0]}, I can also list ${visibleNames.length} table(s): ${formatListPreview(visibleNames)}.`
            : undefined,
      } satisfies DirectMetadataReply;
    }

    return {
      answer: `In the current connection I only have metadata for ${args.activeSchema || schemaNames[0] || "the current schema/database"}.`,
      followup: visibleNames.length
        ? `It currently contains ${visibleNames.length} table(s): ${formatListPreview(visibleNames)}.`
        : undefined,
    } satisfies DirectMetadataReply;
  }

  if (asksSchemas) {
    return {
      answer: schemaNames.length
        ? `I can currently see ${schemaNames.length} schema(s): ${formatListPreview(schemaNames)}.`
        : "I do not have any schema metadata loaded yet.",
    } satisfies DirectMetadataReply;
  }

  if (asksTables) {
    return {
      answer: visibleNames.length
        ? `I can currently see ${visibleNames.length} table(s) in ${args.activeSchema || "the current schema"}: ${formatListPreview(visibleNames)}.`
        : `I do not see any tables in ${args.activeSchema || "the current schema"} yet.`,
    } satisfies DirectMetadataReply;
  }

  return null;
}

function needsQuotedIdentifier(name: string) {
  return !/^[a-z_][a-z0-9_]*$/.test(name);
}

function formatColumnForAi(name: string) {
  return needsQuotedIdentifier(name) ? `${name} (quote as "${name}")` : name;
}

function quoteIdentifier(engine: DatabaseEngine, name: string) {
  if (!needsQuotedIdentifier(name)) return name;

  if (engine === "mysql" || engine === "mariadb") {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  if (engine === "sqlserver") {
    return `[${name.replace(/]/g, "]]")}]`;
  }

  return `"${name.replace(/"/g, '""')}"`;
}

function normalizeQuotedIdentifiers(args: {
  engine: DatabaseEngine;
  sql: string;
  columnsByTable?: Record<string, string[]>;
}) {
  const { engine, sql, columnsByTable = {} } = args;
  if (!sql.trim()) return sql;

  let nextSql = sql;

  const allColumns = Array.from(
    new Set(
      Object.values(columnsByTable)
        .flat()
        .map((name) => name.trim())
        .filter((name) => name && needsQuotedIdentifier(name))
    )
  ).sort((a, b) => b.length - a.length);

  for (const column of allColumns) {
    const escaped = column.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = quoteIdentifier(engine, column);

    nextSql = nextSql.replace(
      new RegExp(`\\.(${escaped})(?![\\w"])`, "g"),
      `.${quoted}`
    );

    nextSql = nextSql.replace(
      new RegExp(`(?<![.\\w"\\\`\\]])\\b(${escaped})\\b(?![\\w"\\\`\\]])`, "g"),
      quoted
    );
  }

  nextSql = nextSql.replace(
    /\bAS\s+([A-Za-z_][A-Za-z0-9_]*)/gi,
    (full, alias) => {
      if (!needsQuotedIdentifier(alias)) return full;
      return `AS ${quoteIdentifier(engine, alias)}`;
    }
  );

  return nextSql;
}

export function isReadOnlySql(sql: string) {
  const normalized = sql.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  const withoutTrailingSemicolons = normalized.replace(/;+$/, "").trim();
  if (!withoutTrailingSemicolons) return false;
  if (withoutTrailingSemicolons.includes(";")) return false;
  if (
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE)\b/i.test(
      withoutTrailingSemicolons
    )
  ) {
    return false;
  }
  return /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|PRAGMA)\b/i.test(
    withoutTrailingSemicolons
  );
}

export function queryResultToObjects(result: QueryResult, maxRows = 50) {
  const columnNames = (result.columns ?? []).map((col) => col.name);
  return (result.rows ?? []).slice(0, maxRows).map((row) => {
    const out: Record<string, unknown> = {};
    for (let i = 0; i < columnNames.length; i++) {
      out[columnNames[i] ?? `col_${i + 1}`] = row?.[i] ?? null;
    }
    return out;
  });
}

function formatScalarForAnswer(value: unknown) {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function buildFastResultAnswer(args: {
  result: QueryResult;
  preview: Record<string, unknown>[];
}) {
  const rowCount = Number(args.result.rowCount ?? args.preview.length ?? 0);
  const columns = (args.result.columns ?? [])
    .map((col) => col.name)
    .filter(Boolean);

  if (rowCount === 0) {
    return {
      answer: "I ran the query, but it returned no rows.",
      confidence: "high" as const,
    };
  }

  if (args.preview.length === 1 && columns.length === 1) {
    const onlyColumn = columns[0]!;
    return {
      answer: `The result is ${formatScalarForAnswer(args.preview[0]?.[onlyColumn])}.`,
      confidence: "high" as const,
    };
  }

  if (args.preview.length === 1 && columns.length > 1 && columns.length <= 4) {
    const row = args.preview[0] ?? {};
    const summary = columns
      .slice(0, 4)
      .map((col) => `${col}: ${formatScalarForAnswer(row[col])}`)
      .join(", ");
    return {
      answer: `I found 1 row: ${summary}.`,
      confidence: "high" as const,
    };
  }

  if (columns.length === 1 && rowCount <= 5) {
    const col = columns[0]!;
    const values = args.preview
      .slice(0, 5)
      .map((row) => formatScalarForAnswer(row[col]))
      .join(", ");
    return {
      answer: `I found ${rowCount} row(s). ${col}: ${values}.`,
      confidence: "high" as const,
    };
  }

  return {
    answer: `I ran the query and found ${rowCount} row(s). Here is a preview of the result.`,
    confidence:
      rowCount <= args.preview.length
        ? ("high" as const)
        : ("medium" as const as "high" | "medium" | "low"),
  };
}

export async function planSqlFromQuestion(args: {
  endpoint: string;
  model: string;
  engine: DatabaseEngine;
  question: string;
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  currentSql?: string;
  history?: AiHistoryItem[];
  onStatusChange?: (status: "loading_model" | "generating") => void;
  signal?: AbortSignal;
}) {
  const preferredReplyLanguage = getPreferredReplyLanguage(
    args.question,
    args.history
  );
  const schemaSummary = toSchemaLines({
    activeSchema: args.activeSchema,
    tables: args.tables,
    columnsByTable: args.columnsByTable,
    question: args.question,
  });
  const conversationSummary = toConversationLines(args.history);
  const prompt = buildSqlPlanPrompt({
    engine: args.engine,
    activeSchema: args.activeSchema,
    preferredReplyLanguage,
    conversationSummary,
    schemaSummary,
    currentSql: args.currentSql,
    question: args.question,
  });

  const raw = await generateJson<Partial<AiPlan>>({
    endpoint: args.endpoint,
    model: args.model,
    prompt,
    maxTokens: 320,
    onStatusChange: args.onStatusChange,
    signal: args.signal,
  });

  return {
    sql: normalizeQuotedIdentifiers({
      engine: args.engine,
      sql: sanitizeAiText(raw?.sql),
      columnsByTable: args.columnsByTable,
    }).trim(),
    explanation: sanitizeAiText(raw?.explanation),
    assumptions: sanitizeAiStringArray(raw?.assumptions),
    safety:
      raw?.safety === "read_only" ||
      raw?.safety === "mutating" ||
      raw?.safety === "unknown"
        ? raw.safety
        : "unknown",
    needsClarification: Boolean(raw?.needsClarification),
    clarification: sanitizeAiText(raw?.clarification),
  } satisfies AiPlan;
}

export async function answerFromResult(args: {
  endpoint: string;
  model: string;
  engine: DatabaseEngine;
  question: string;
  sql: string;
  result: QueryResult;
  onStatusChange?: (status: "loading_model" | "generating") => void;
  signal?: AbortSignal;
  history?: AiHistoryItem[];
}) {
  const preferredReplyLanguage = getPreferredReplyLanguage(
    args.question,
    args.history
  );
  const rows = queryResultToObjects(args.result, 50);
  const prompt = buildResultAnswerPrompt({
    engine: args.engine,
    preferredReplyLanguage,
    question: args.question,
    sql: args.sql,
    rowCount: Number(args.result.rowCount ?? rows.length),
    columns: (args.result.columns ?? []).map((col) => col.name).join(", "),
    rowsJson: JSON.stringify(rows, null, 2),
  });

  const raw = await generateJson<Partial<AiAnswer>>({
    endpoint: args.endpoint,
    model: args.model,
    prompt,
    maxTokens: 160,
    onStatusChange: args.onStatusChange,
    signal: args.signal,
  });

  return {
    answer: sanitizeAiText(raw?.answer),
    highlights: sanitizeAiStringArray(raw?.highlights),
    confidence:
      raw?.confidence === "high" ||
      raw?.confidence === "medium" ||
      raw?.confidence === "low"
        ? raw.confidence
        : "medium",
  } satisfies AiAnswer;
}

export function isGeneralChatPrompt(question: string) {
  const text = normalizeIntentText(question);
  if (!text) return false;

  if (
    [
      /\b(use|answer|reply|respond|speak)( in)? english\b/,
      /\b(use|answer|reply|respond|speak)( in)? vietnamese\b/,
      /\btieng anh\b/,
      /\btieng viet\b/,
      /\bshort(er)? answer\b/,
      /\bbrief(ly)?\b/,
      /\bngan gon\b/,
      /\bgiai thich ngan gon\b/,
      /\bchi tra loi\b/,
      /\bdung tao sql\b/,
      /\bdon't use sql\b/,
      /\bdo not use sql\b/,
      /\bthanks?\b/,
      /\bcam on\b/,
      /^(ok|okay|oke|duoc|roi|continue|tiep di)\b/,
    ].some((pattern) => pattern.test(text))
  ) {
    return !hasDatabaseIntent(text);
  }

  return [
    /^(hi|hello|hey|yo)\b/,
    /^(xin chao|chao|helo|alo)\b/,
    /\b(ban la ai|ban giup duoc gi|ban lam duoc gi|co the lam gi|huong dan toi)\b/,
    /\b(who are you|what can you do|help me|how can you help)\b/,
  ].some((pattern) => pattern.test(text));
}

export function getFastChatReply(question: string): AiChatReply | null {
  const text = normalizeIntentText(question);
  if (!text) return null;

  if (/^(hi|hello|hey|yo|xin chao|chao|helo|alo)\b/.test(text)) {
    return {
      answer: "Hello! How can I assist you today?",
      followup:
        "You can ask me about your data, request SQL, or ask me to explain a query.",
    };
  }

  if (/\b(thanks?|cam on)\b/.test(text)) {
    return {
      answer: "You're welcome.",
      followup: "Let me know if you'd like help with data or SQL.",
    };
  }

  if (/^(ok|okay|oke|duoc|roi|continue|tiep di)\b/.test(text)) {
    return {
      answer: "Sure.",
      followup: "Tell me what you want to do next with the database.",
    };
  }

  if (
    /\b(use|answer|reply|respond|speak)( in)? english\b/.test(text) ||
    /\btieng anh\b/.test(text) ||
    /\b(use|answer|reply|respond|speak)( in)? vietnamese\b/.test(text) ||
    /\btieng viet\b/.test(text)
  ) {
    return {
      answer: "Understood. I will continue in English.",
    };
  }

  if (
    /\b(who are you|what can you do|help me|how can you help)\b/.test(text) ||
    /\b(ban la ai|ban giup duoc gi|ban lam duoc gi|co the lam gi|huong dan toi)\b/.test(
      text
    )
  ) {
    return {
      answer:
        "I am PoliteDB AI Assistant. I can answer database questions, suggest SQL, explain queries, and summarize query results.",
    };
  }

  return null;
}

export async function chatReply(args: {
  endpoint: string;
  model: string;
  engine: DatabaseEngine;
  question: string;
  activeSchema?: string;
  tables: TableItem[];
  history?: AiHistoryItem[];
  onStatusChange?: (status: "loading_model" | "generating") => void;
  signal?: AbortSignal;
}) {
  const preferredReplyLanguage = getPreferredReplyLanguage(
    args.question,
    args.history
  );
  const visibleTables = args.tables
    .filter((table) => !args.activeSchema || table.schema === args.activeSchema)
    .slice(0, 12)
    .map((table) => `${table.schema}.${table.name}`)
    .join(", ");
  const conversationSummary = toConversationLines(args.history);

  const prompt = buildChatReplyPrompt({
    engine: args.engine,
    activeSchema: args.activeSchema,
    preferredReplyLanguage,
    visibleTables,
    conversationSummary,
    question: args.question,
  });
  const raw = await generateJson<Partial<AiChatReply>>({
    endpoint: args.endpoint,
    model: args.model,
    prompt,
    maxTokens: 64,
    onStatusChange: args.onStatusChange,
    signal: args.signal,
  });

  return {
    answer: sanitizeAiText(raw?.answer),
    followup: sanitizeAiText(raw?.followup) || undefined,
  } satisfies AiChatReply;
}
