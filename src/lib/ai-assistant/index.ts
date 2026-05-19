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
  buildChatReplyPlainPrompt,
  buildChatReplyPrompt,
  buildIntentClassifierPrompt,
  buildResultAnswerPlainPrompt,
  buildResultAnswerPrompt,
  buildSqlPlanPrompt,
} from "@root/src/lib/ai-assistant/prompts";
import {
  detectQuestionLanguageCode,
  formatReplyLanguageForPrompt,
  parseExplicitLanguageRequest,
  resolveReplyLanguage,
  supportsLocalizedFastPath,
  toReplyLanguageInfo,
  type ReplyLanguageInfo,
} from "@root/src/lib/ai-assistant/language";
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
} from "@root/src/lib/ai-assistant/types";

export {
  detectLanguageFromText,
  detectQuestionLanguageCode,
  formatReplyLanguageForPrompt,
  languageNameFromCode,
  parseExplicitLanguageRequest,
  resolveReplyLanguage,
  supportsLocalizedFastPath,
  toReplyLanguageInfo,
  type ReplyLanguageInfo,
} from "@root/src/lib/ai-assistant/language";

export {
  extractTablesFromSql,
  formatSqlExecutionError,
  formatSqlValidationIssues,
  parseDatabaseExecutionError,
  validateSqlAgainstMetadata,
  type SqlMetadataIssue,
  type SqlMetadataValidation,
} from "@root/src/lib/ai-assistant/sqlMetadata";

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

function extractStreamingJsonStringField(buffer: string, field: string) {
  const pattern = new RegExp(
    `"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)(?:")?`,
    "s"
  );
  const match = pattern.exec(buffer);
  if (!match?.[1]) return "";
  try {
    return JSON.parse(`"${match[1]}"`);
  } catch {
    return match[1]
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

async function readStreamingCompletion(
  res: Response,
  onDelta?: (text: string) => void
) {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("OLLAMA_GENERATE_FAILED: empty streaming response body");
  }

  const decoder = new TextDecoder();
  let accumulated = "";
  let sseBuffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    sseBuffer += decoder.decode(value, { stream: true });
    const lines = sseBuffer.split("\n");
    sseBuffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;

      try {
        const parsed = JSON.parse(payload);
        const delta = String(parsed?.choices?.[0]?.delta?.content ?? "");
        if (!delta) continue;
        accumulated += delta;
        onDelta?.(accumulated);
      } catch {
        // ignore malformed SSE chunks
      }
    }
  }

  return accumulated.trim();
}

async function generateText(opts: GenerateOptions): Promise<string> {
  const endpoint = trimTrailingSlash(opts.endpoint.trim());
  const maxTokens = Math.max(32, Math.min(opts.maxTokens ?? 256, 1024));
  const useStream = Boolean(opts.onDelta);

  for (let attempt = 0; attempt <= MODEL_LOADING_MAX_RETRIES; attempt++) {
    throwIfAborted(opts.signal);
    opts.onStatusChange?.("generating");
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      signal: opts.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: useStream ? "text/event-stream" : "application/json",
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
        stream: useStream,
      }),
    });

    if (res.ok) {
      if (useStream) {
        return await readStreamingCompletion(res, opts.onDelta);
      }
      const data = await res.json();
      const content = String(data?.choices?.[0]?.message?.content ?? "").trim();
      opts.onDelta?.(content);
      return content;
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

function getPreferredReplyLanguage(
  question: string,
  history: AiHistoryItem[] = []
): ReplyLanguageInfo {
  return resolveReplyLanguage(question, history);
}

function normalizeIntentLanguageField(
  value: unknown,
  fallback: ReplyLanguageInfo
): ReplyLanguageInfo {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (!raw) return fallback;
  if (raw === "unknown" || raw === "und") return fallback;
  if (raw === "english" || raw === "en") return toReplyLanguageInfo("eng");
  if (raw === "vietnamese" || raw === "vi") return toReplyLanguageInfo("vie");
  if (/^[a-z]{3}$/.test(raw)) return toReplyLanguageInfo(raw);
  return fallback;
}

function hasDatabaseIntent(text: string) {
  const normalized = normalizeIntentText(text);
  if (!normalized) return false;

  return [
    /\b(sql|query|table|column|schema|database|db|row|filter|where|join|group by|order by)\b/,
    /\b(select|insert|update|delete|truncate|drop|alter|create|count|list|show|find|get|top|latest|newest|oldest|compare|trend|sum|avg|average|max|min|duplicate|missing)\b/,
    /\b(liet ke|dem|tim|hien thi|truy van|sap xep|loc|thong ke|so sanh|tong|trung binh|lon nhat|nho nhat|moi nhat|cau lenh|lenh sql)\b/,
  ].some((pattern) => pattern.test(normalized));
}

/** True when the user wants row data from a table, not a schema listing. */
export function wantsTableData(question: string) {
  const text = normalizeIntentText(question);
  if (!text) return false;

  if (
    /\b(show|display|view|see|get|fetch|read|print|preview|hien thi|xem|lay|cho xem)\s+(?:me\s+)?(?:the\s+)?(?:all\s+)?(?:data|rows|records|du lieu|ban ghi)\b/.test(
      text
    ) ||
    /\b(data|rows|records|du lieu|ban ghi)\s+(?:from|in|of|tu|cua|trong)\s+\w+/.test(
      text
    ) ||
    /\b(show|display|hien thi|xem)\s+.+\s+(?:data|rows|records|du lieu)\b/.test(
      text
    )
  ) {
    return true;
  }

  if (
    /\b(list|liet ke)\s+(?:all\s+)?tables?\b/.test(text) ||
    /\bwhat\s+tables?\b/.test(text) ||
    /\b(tat ca|toan bo|all)\s+tables?\b/.test(text)
  ) {
    return false;
  }

  if (
    /\b(list|liet ke|show|display|hien thi|xem)\s+(?!all\b|tables?\b|schemas?\b|databases?\b)[a-z0-9_]+\b/.test(
      text
    )
  ) {
    return true;
  }

  return /\b(show|display|view|see|get|hien thi|xem)\s+\w+\s+(?:table|bang)\b/.test(
    text
  );
}

function extractTableNameFromDataRequest(text: string) {
  const patterns = [
    /\bshow\s+data\s+([a-z0-9_]+)(?:\s+table)?\b/,
    /\b(?:display|view|get|fetch|hien thi|xem|lay)\s+(?:du lieu|ban ghi|data|rows|records)\s+(?:bang\s+|table\s+)?([a-z0-9_]+)\b/,
    /\b(?:show|display|view|get|fetch|hien thi|xem|lay)\s+(?:me\s+)?(?:the\s+)?(?:all\s+)?(?:data|rows|records|du lieu|ban ghi)\s+(?:(?:from|in|of|tu|cua|trong)\s+)?(?:(?:the\s+)?(?:table|bang)\s+)?([a-z0-9_]+)\b/,
    /\b(?:data|rows|records|du lieu|ban ghi)\s+(?:from|in|of|tu|cua|trong)\s+(?:(?:the\s+)?(?:table|bang)\s+)?([a-z0-9_]+)\b/,
    /\b(?:show|display|hien thi|xem)\s+([a-z0-9_]+)\s+(?:table|bang)\b/,
  ];

  const skip = new Set(["table", "tables", "data", "rows", "records", "bang", "du", "lieu"]);

  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const name = match?.[1]?.toLowerCase();
    if (name && !skip.has(name)) return name;
  }

  return null;
}

/** True when the user wants generated SQL, not a schema/table listing. */
export function wantsSqlGeneration(question: string) {
  if (wantsTableData(question)) return true;

  const text = normalizeIntentText(question);
  if (!text) return false;

  return [
    /\b(truncate|select|insert|update|delete|drop|alter|create|grant|revoke|merge|replace)\b/,
    /\b(cau lenh|lenh sql|viet sql|tao sql|generate sql|write sql|sql command|sql query)\b/,
    /\b(cho|give|show|write|create|generate)\s+(me\s+)?(the\s+)?(a\s+)?(sql|cau lenh|query)\b/,
    /\b(explain|run|execute|fix|improve|optimize)(\s+(this|the))?\s+sql\b/,
  ].some((pattern) => pattern.test(text));
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

  const lang = resolveReplyLanguage(args.question, args.history);
  if (lang.code === "vie") {
    return {
      answer: "Tôi chưa chắc bạn muốn làm gì với dữ liệu.",
      followup:
        "Hãy mô tả rõ hơn, ví dụ: hiển thị 10 dòng mới nhất, đếm bản ghi, lọc theo điều kiện, hoặc giải thích một câu SQL cụ thể.",
    };
  }

  if (!supportsLocalizedFastPath(lang)) {
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

  const detectedReplyLanguage = resolveReplyLanguage(
    args.question,
    args.history
  );
  const questionLanguage = String(raw?.questionLanguage ?? "").trim()
    ? normalizeIntentLanguageField(
        raw?.questionLanguage,
        toReplyLanguageInfo(
          detectQuestionLanguageCode(args.question) === "unknown"
            ? detectedReplyLanguage.code
            : detectQuestionLanguageCode(args.question)
        )
      ).code
    : detectQuestionLanguageCode(args.question);
  const replyLanguage = normalizeIntentLanguageField(
    raw?.replyLanguage,
    questionLanguage !== "unknown"
      ? toReplyLanguageInfo(questionLanguage)
      : detectedReplyLanguage
  );

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

function findTableInContext(
  tables: TableItem[],
  tableName: string,
  activeSchema?: string
) {
  const normalizedName = tableName.toLowerCase();
  const matches = tables.filter(
    (table) => table.name.toLowerCase() === normalizedName
  );
  if (!matches.length) return null;
  if (activeSchema) {
    return matches.find((table) => table.schema === activeSchema) ?? matches[0];
  }
  return matches[0] ?? null;
}

export function getFastSqlReply(args: {
  engine: DatabaseEngine;
  question: string;
  activeSchema?: string;
  tables: TableItem[];
}): { sql: string; explanation: string } | null {
  const text = normalizeIntentText(args.question);
  const lang = resolveReplyLanguage(args.question);
  const vi = lang.code === "vie";

  if (wantsTableData(args.question)) {
    const tableName = extractTableNameFromDataRequest(text);
    if (tableName) {
      const table = findTableInContext(args.tables, tableName, args.activeSchema);
      const schema = table?.schema ?? args.activeSchema ?? "public";
      const name = table?.name ?? tableName;
      const qualified = `${quoteIdentifier(args.engine, schema)}.${quoteIdentifier(args.engine, name)}`;

      return {
        sql: `SELECT * FROM ${qualified} LIMIT 50;`,
        explanation: vi
          ? table
            ? `Hiển thị tối đa 50 dòng từ bảng ${schema}.${name}.`
            : `Gợi ý truy vấn dữ liệu cho bảng ${schema}.${name}. Hãy xác nhận bảng tồn tại.`
          : table
            ? `Showing up to 50 rows from ${schema}.${name}.`
            : `Suggested data query for ${schema}.${name}. Verify the table exists.`,
      };
    }
    return null;
  }

  if (!wantsSqlGeneration(args.question)) return null;

  const truncateMatch = text.match(
    /\btruncate\s+(?:table\s+)?(?:(?:([a-z0-9_]+)\.)?([a-z0-9_]+)|table\s+([a-z0-9_]+))\b/
  );
  if (truncateMatch) {
    const schemaFromQuestion = truncateMatch[1];
    const tableName = truncateMatch[2] || truncateMatch[3];
    if (!tableName) return null;

    const table = schemaFromQuestion
      ? args.tables.find(
          (item) =>
            item.name.toLowerCase() === tableName &&
            item.schema.toLowerCase() === schemaFromQuestion
        )
      : findTableInContext(args.tables, tableName, args.activeSchema);

    const schema =
      table?.schema ?? schemaFromQuestion ?? args.activeSchema ?? "public";
    const name = table?.name ?? tableName;
    const qualified = `${quoteIdentifier(args.engine, schema)}.${quoteIdentifier(args.engine, name)}`;

    return {
      sql: `TRUNCATE TABLE ${qualified};`,
      explanation:
        vi
          ? table
            ? `Xóa toàn bộ dòng trong ${schema}.${name}. Hãy kiểm tra kỹ trước khi chạy lệnh này.`
            : `Gợi ý TRUNCATE cho ${schema}.${name}. Hãy xác nhận bảng tồn tại trước khi chạy.`
          : table
            ? `Removes all rows from ${schema}.${name}. Review carefully before running this statement.`
            : `Suggested TRUNCATE for ${schema}.${name}. Verify the table exists before running.`,
    };
  }

  return null;
}

export function looksLikeMetadataQuestion(question: string) {
  if (wantsSqlGeneration(question) || wantsTableData(question)) return false;

  const text = normalizeIntentText(question);
  if (!text) return false;

  const asksAllDatabases = [
    /\b(all )?(database|databases|db)\b/,
    /\b(toan bo db|tat ca db|liet ke db|hien thi db)\b/,
    /\b(toutes les bases|liste des bases|bases de donnees)\b/,
    /\b(alle datenbanken|datenbanken)\b/,
    /\b(todas las bases de datos|bases de datos)\b/,
  ].some((pattern) => pattern.test(text));

  const asksSchemas = [
    /\b(schema|schemas)\b/,
    /\b(so do|liet ke schema|tat ca schema)\b/,
    /\b(schemas?|liste des schemas)\b/,
    /\b(esquemas?)\b/,
  ].some((pattern) => pattern.test(text));

  const asksTables = [
    /\b(table|tables|collection|collections|key|keys)\b/,
    /\b(liet ke bang|tat ca bang|toan bo bang|liet ke collection|liet ke key)\b/,
    /\b(tables?|liste des tables|montre les tables)\b/,
    /\b(tablas?|mostrar tablas)\b/,
    /\b(tabellen|zeige tabellen)\b/,
    /\b(colecciones?|claves?)\b/,
  ].some((pattern) => pattern.test(text));

  const asksListLike = [
    /\b(list|show|display|what are|which are|give me)\b/,
    /\b(liet ke|hien thi|cho toi|toan bo|tat ca|common)\b/,
    /\b(montre|affiche|liste|quels sont)\b/,
    /\b(muestra|lista|mostrar)\b/,
    /\b(zeige|auflisten|anzeigen)\b/,
  ].some((pattern) => pattern.test(text));

  if (
    asksListLike &&
    !asksTables &&
    !asksSchemas &&
    !asksAllDatabases &&
    /\b(list|liet ke)\s+(?!all\b|tables?\b|schemas?\b|databases?\b)[a-z0-9_]+\b/.test(
      text
    )
  ) {
    return false;
  }

  return asksListLike || asksAllDatabases || asksSchemas || asksTables;
}

export function getDirectMetadataReply(args: {
  engine: DatabaseEngine;
  question: string;
  activeSchema?: string;
  tables: TableItem[];
}) {
  if (!looksLikeMetadataQuestion(args.question)) return null;

  const text = normalizeIntentText(args.question);
  const visibleTables = args.tables.filter(
    (table) => !args.activeSchema || table.schema === args.activeSchema
  );
  const visibleNames = visibleTables.map((table) => table.name);
  const schemaNames = Array.from(
    new Set(args.tables.map((table) => table.schema).filter(Boolean))
  );

  const asksAllDatabases =
    /\b(all )?(database|databases|db)\b/.test(text) ||
    /\b(toan bo db|tat ca db|liet ke db|hien thi db)\b/.test(text) ||
    /\b(toutes les bases|bases de donnees)\b/.test(text) ||
    /\b(alle datenbanken)\b/.test(text) ||
    /\b(todas las bases de datos|bases de datos)\b/.test(text);
  const asksSchemas =
    /\b(schema|schemas)\b/.test(text) ||
    /\b(so do|liet ke schema|tat ca schema)\b/.test(text) ||
    /\b(liste des schemas|esquemas?)\b/.test(text);
  const asksTables =
    /\b(table|tables|collection|collections|key|keys)\b/.test(text) ||
    /\b(liet ke bang|tat ca bang|toan bo bang|liet ke collection|liet ke key)\b/.test(
      text
    ) ||
    /\b(liste des tables|tabellen|colecciones?)\b/.test(text) ||
    /\b(tablas|tabla)\b/.test(text);

  const lang = resolveReplyLanguage(args.question);
  if (!supportsLocalizedFastPath(lang)) return null;
  const vi = lang.code === "vie";

  if (
    args.engine === "redis" &&
    (asksTables || asksAllDatabases || asksSchemas)
  ) {
    return {
      answer:
        vi
          ? visibleNames.length
            ? `Hiện có ${visibleNames.length} key trong db ${args.activeSchema || "0"}: ${formatListPreview(visibleNames)}.`
            : `Chưa thấy key nào trong db ${args.activeSchema || "0"}.`
          : visibleNames.length
            ? `I can currently see ${visibleNames.length} key(s) in db ${args.activeSchema || "0"}: ${formatListPreview(visibleNames)}.`
            : `I do not see any keys in db ${args.activeSchema || "0"} yet.`,
    } satisfies DirectMetadataReply;
  }

  if (
    args.engine === "mongo" &&
    (asksTables || asksAllDatabases || asksSchemas)
  ) {
    return {
      answer:
        vi
          ? visibleNames.length
            ? `Hiện có ${visibleNames.length} collection trong database ${args.activeSchema || "(hiện tại)"}: ${formatListPreview(visibleNames)}.`
            : `Chưa thấy collection nào trong database ${args.activeSchema || "(hiện tại)"}.`
          : visibleNames.length
            ? `I can currently see ${visibleNames.length} collection(s) in database ${args.activeSchema || "(current)"}: ${formatListPreview(visibleNames)}.`
            : `I do not see any collections in database ${args.activeSchema || "(current)"} yet.`,
    } satisfies DirectMetadataReply;
  }

  if (asksAllDatabases) {
    if (schemaNames.length > 1) {
      return {
        answer:
          vi
            ? `Trong kết nối hiện tại có ${schemaNames.length} schema/database: ${formatListPreview(schemaNames)}.`
            : `In the current connection I can see ${schemaNames.length} schema/database name(s): ${formatListPreview(schemaNames)}.`,
        followup:
          visibleNames.length > 0
            ? vi
              ? `Trong phạm vi ${args.activeSchema || schemaNames[0]}, còn có ${visibleNames.length} bảng: ${formatListPreview(visibleNames)}.`
              : `For the active scope ${args.activeSchema || schemaNames[0]}, I can also list ${visibleNames.length} table(s): ${formatListPreview(visibleNames)}.`
            : undefined,
      } satisfies DirectMetadataReply;
    }

    return {
      answer:
        vi
          ? `Trong kết nối hiện tại chỉ có metadata cho ${args.activeSchema || schemaNames[0] || "schema/database hiện tại"}.`
          : `In the current connection I only have metadata for ${args.activeSchema || schemaNames[0] || "the current schema/database"}.`,
      followup: visibleNames.length
        ? vi
          ? `Hiện có ${visibleNames.length} bảng: ${formatListPreview(visibleNames)}.`
          : `It currently contains ${visibleNames.length} table(s): ${formatListPreview(visibleNames)}.`
        : undefined,
    } satisfies DirectMetadataReply;
  }

  if (asksSchemas) {
    return {
      answer:
        vi
          ? schemaNames.length
            ? `Hiện có ${schemaNames.length} schema: ${formatListPreview(schemaNames)}.`
            : "Chưa có metadata schema nào."
          : schemaNames.length
            ? `I can currently see ${schemaNames.length} schema(s): ${formatListPreview(schemaNames)}.`
            : "I do not have any schema metadata loaded yet.",
    } satisfies DirectMetadataReply;
  }

  if (asksTables) {
    return {
      answer:
        vi
          ? visibleNames.length
            ? `Hiện có ${visibleNames.length} bảng trong ${args.activeSchema || "schema hiện tại"}: ${formatListPreview(visibleNames)}.`
            : `Chưa thấy bảng nào trong ${args.activeSchema || "schema hiện tại"}.`
          : visibleNames.length
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
  language?: ReplyLanguageInfo;
}): Pick<AiAnswer, "answer" | "confidence"> | null {
  const lang = args.language ?? toReplyLanguageInfo("eng");
  if (!supportsLocalizedFastPath(lang)) return null;

  const vi = lang.code === "vie";
  const rowCount = Number(args.result.rowCount ?? args.preview.length ?? 0);
  const columns = (args.result.columns ?? [])
    .map((col) => col.name)
    .filter(Boolean);

  if (rowCount === 0) {
    return {
      answer:
        vi
          ? "Đã chạy truy vấn nhưng không có dòng nào."
          : "I ran the query, but it returned no rows.",
      confidence: "high" as const,
    };
  }

  if (args.preview.length === 1 && columns.length === 1) {
    const onlyColumn = columns[0]!;
    const value = formatScalarForAnswer(args.preview[0]?.[onlyColumn]);
    return {
      answer:
        vi ? `Kết quả là ${value}.` : `The result is ${value}.`,
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
      answer:
        vi ? `Tìm thấy 1 dòng: ${summary}.` : `I found 1 row: ${summary}.`,
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
      answer:
        vi
          ? `Tìm thấy ${rowCount} dòng. ${col}: ${values}.`
          : `I found ${rowCount} row(s). ${col}: ${values}.`,
      confidence: "high" as const,
    };
  }

  return {
    answer:
      vi
        ? `Đã chạy truy vấn và tìm thấy ${rowCount} dòng. Dưới đây là phần xem trước kết quả.`
        : `I ran the query and found ${rowCount} row(s). Here is a preview of the result.`,
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
  onDelta?: (text: string) => void;
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
    preferredReplyLanguage: formatReplyLanguageForPrompt(preferredReplyLanguage),
    conversationSummary,
    schemaSummary,
    currentSql: args.currentSql,
    question: args.question,
  });

  let raw: Partial<AiPlan>;
  if (args.onDelta) {
    let lastExplanation = "";
    const content = await generateText({
      endpoint: args.endpoint,
      model: args.model,
      prompt,
      maxTokens: 320,
      onStatusChange: args.onStatusChange,
      signal: args.signal,
      onDelta: (accumulated) => {
        const explanation = extractStreamingJsonStringField(
          accumulated,
          "explanation"
        );
        const clarification = extractStreamingJsonStringField(
          accumulated,
          "clarification"
        );
        const nextText = explanation || clarification;
        if (nextText && nextText !== lastExplanation) {
          lastExplanation = nextText;
          args.onDelta?.(nextText);
        }
      },
    });
    raw = extractJsonObject(content) as Partial<AiPlan>;
  } else {
    raw = await generateJson<Partial<AiPlan>>({
      endpoint: args.endpoint,
      model: args.model,
      prompt,
      maxTokens: 320,
      onStatusChange: args.onStatusChange,
      signal: args.signal,
    });
  }

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
  onDelta?: (text: string) => void;
  signal?: AbortSignal;
  history?: AiHistoryItem[];
}) {
  const preferredReplyLanguage = getPreferredReplyLanguage(
    args.question,
    args.history
  );
  const rows = queryResultToObjects(args.result, 50);
  if (args.onDelta) {
    const answer = sanitizeAiText(
      await generateText({
        endpoint: args.endpoint,
        model: args.model,
        prompt: buildResultAnswerPlainPrompt({
          engine: args.engine,
          preferredReplyLanguage:
            formatReplyLanguageForPrompt(preferredReplyLanguage),
          question: args.question,
          sql: args.sql,
          rowCount: Number(args.result.rowCount ?? rows.length),
          columns: (args.result.columns ?? [])
            .map((col) => col.name)
            .join(", "),
          rowsJson: JSON.stringify(rows, null, 2),
        }),
        maxTokens: 160,
        onStatusChange: args.onStatusChange,
        signal: args.signal,
        onDelta: args.onDelta,
      })
    );

    return {
      answer,
      highlights: [],
      confidence: "medium",
    } satisfies AiAnswer;
  }

  const prompt = buildResultAnswerPrompt({
    engine: args.engine,
    preferredReplyLanguage: formatReplyLanguageForPrompt(preferredReplyLanguage),
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

  if (parseExplicitLanguageRequest(question) && !hasDatabaseIntent(text)) {
    return true;
  }

  if (
    [
      /\b(use|answer|reply|respond|speak|write)( in)? english\b/,
      /\b(use|answer|reply|respond|speak|write)( in)? vietnamese\b/,
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

  const explicit = parseExplicitLanguageRequest(question);
  if (explicit) {
    return {
      answer: `Understood. I will reply in ${explicit.name}.`,
    };
  }

  const lang = resolveReplyLanguage(question);
  if (!supportsLocalizedFastPath(lang)) return null;

  const vi = lang.code === "vie";

  if (/^(hi|hello|hey|yo|xin chao|chao|helo|alo)\b/.test(text)) {
    return vi
      ? {
          answer: "Xin chào! Tôi có thể giúp gì cho bạn?",
          followup:
            "Bạn có thể hỏi về dữ liệu, yêu cầu SQL, hoặc nhờ tôi giải thích một truy vấn.",
        }
      : {
          answer: "Hello! How can I assist you today?",
          followup:
            "You can ask me about your data, request SQL, or ask me to explain a query.",
        };
  }

  if (/\b(thanks?|cam on)\b/.test(text)) {
    return vi
      ? {
          answer: "Không có gì.",
          followup: "Cần hỗ trợ thêm về dữ liệu hoặc SQL cứ nói nhé.",
        }
      : {
          answer: "You're welcome.",
          followup: "Let me know if you'd like help with data or SQL.",
        };
  }

  if (/^(ok|okay|oke|duoc|roi|continue|tiep di)\b/.test(text)) {
    return vi
      ? {
          answer: "Được.",
          followup: "Bạn muốn làm gì tiếp theo với cơ sở dữ liệu?",
        }
      : {
          answer: "Sure.",
          followup: "Tell me what you want to do next with the database.",
        };
  }

  if (
    /\b(who are you|what can you do|help me|how can you help)\b/.test(text) ||
    /\b(ban la ai|ban giup duoc gi|ban lam duoc gi|co the lam gi|huong dan toi)\b/.test(
      text
    )
  ) {
    return {
      answer: vi
        ? "Tôi là PoliteDB AI Assistant. Tôi có thể trả lời câu hỏi về dữ liệu, gợi ý SQL, giải thích truy vấn và tóm tắt kết quả."
        : "I am PoliteDB AI Assistant. I can answer database questions, suggest SQL, explain queries, and summarize query results.",
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
  onDelta?: (text: string) => void;
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

  if (args.onDelta) {
    const answer = sanitizeAiText(
      await generateText({
        endpoint: args.endpoint,
        model: args.model,
        prompt: buildChatReplyPlainPrompt({
          engine: args.engine,
          activeSchema: args.activeSchema,
          preferredReplyLanguage:
            formatReplyLanguageForPrompt(preferredReplyLanguage),
          visibleTables,
          conversationSummary,
          question: args.question,
        }),
        maxTokens: 192,
        onStatusChange: args.onStatusChange,
        signal: args.signal,
        onDelta: args.onDelta,
      })
    );

    return {
      answer,
      followup: undefined,
    } satisfies AiChatReply;
  }

  const prompt = buildChatReplyPrompt({
    engine: args.engine,
    activeSchema: args.activeSchema,
    preferredReplyLanguage: formatReplyLanguageForPrompt(preferredReplyLanguage),
    visibleTables,
    conversationSummary,
    question: args.question,
  });
  const raw = await generateJson<Partial<AiChatReply>>({
    endpoint: args.endpoint,
    model: args.model,
    prompt,
    maxTokens: 192,
    onStatusChange: args.onStatusChange,
    signal: args.signal,
  });

  return {
    answer: sanitizeAiText(raw?.answer),
    followup: sanitizeAiText(raw?.followup) || undefined,
  } satisfies AiChatReply;
}
