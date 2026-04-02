import type { DatabaseEngine, TableItem } from "src/types";
import type { QueryResult } from "src/lib/tauri";

const AI_ENDPOINT_KEY = "politedb.ai.endpoint";
const AI_MODEL_KEY = "politedb.ai.model";
const AI_MODEL_SEEN_KEY = "politedb.ai.model.seen";

export type LocalAiSettings = {
  endpoint: string;
  model: string;
};

export type AiPlan = {
  sql: string;
  explanation: string;
  assumptions: string[];
  safety: "read_only" | "mutating" | "unknown";
  needsClarification: boolean;
  clarification: string;
};

export type AiAnswer = {
  answer: string;
  highlights: string[];
  confidence: "high" | "medium" | "low";
};

export type AiChatReply = {
  answer: string;
  followup?: string;
};

type GenerateOptions = {
  endpoint: string;
  model: string;
  prompt: string;
  onStatusChange?: (status: "loading_model" | "generating") => void;
  signal?: AbortSignal;
};

const MODEL_LOADING_MAX_RETRIES = 20;
const MODEL_LOADING_RETRY_MS = 1500;

const DEFAULT_AI_SETTINGS: LocalAiSettings = {
  endpoint: "http://127.0.0.1:11434",
  model: "qwen2.5-coder:7b",
};

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

  throw new Error("OLLAMA_GENERATE_FAILED: timed out waiting for model to load");
}

function toSchemaLines(args: {
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
}) {
  const { activeSchema, tables, columnsByTable = {} } = args;

  const visibleTables = tables
    .filter((table) => !activeSchema || table.schema === activeSchema)
    .slice(0, 120);

  if (!visibleTables.length) {
    return "No table metadata is loaded yet.";
  }

  return visibleTables
    .map((table) => {
      const key = `${table.schema}.${table.name}`;
      const cols = (columnsByTable[key] ?? []).slice(0, 40);
      const suffix = cols.length
        ? `(${cols.map(formatColumnForAi).join(", ")})`
        : "(columns unknown)";
      return `- ${table.schema}.${table.name} ${suffix}`;
    })
    .join("\n");
}

function needsQuotedIdentifier(name: string) {
  return !/^[a-z_][a-z0-9_]*$/.test(name);
}

function formatColumnForAi(name: string) {
  return needsQuotedIdentifier(name)
    ? `${name} (quote as "${name}")`
    : name;
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
  if (normalized.includes(";")) return false;
  if (
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|REPLACE|MERGE|GRANT|REVOKE)\b/i.test(
      normalized
    )
  ) {
    return false;
  }
  return /^(SELECT|WITH|SHOW|DESCRIBE|DESC|EXPLAIN|PRAGMA)\b/i.test(normalized);
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

export async function planSqlFromQuestion(args: {
  endpoint: string;
  model: string;
  engine: DatabaseEngine;
  question: string;
  activeSchema?: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  currentSql?: string;
  onStatusChange?: (status: "loading_model" | "generating") => void;
  signal?: AbortSignal;
}) {
  const schemaSummary = toSchemaLines(args);
  const prompt = [
    "You are a database copilot inside PoliteDB.",
    `Database engine: ${args.engine}`,
    `Active schema or database: ${args.activeSchema || "(not selected)"}`,
    "",
    "Available tables and columns:",
    schemaSummary,
    "",
    args.currentSql?.trim()
      ? `Current SQL in editor:\n${args.currentSql.trim()}\n`
      : "",
    "Task:",
    args.question.trim(),
    "",
    'Return JSON only with this exact shape: {"sql":"string","explanation":"string","assumptions":["string"],"safety":"read_only|mutating|unknown","needsClarification":true|false,"clarification":"string"}',
    "Rules:",
    "- Use only listed tables and columns.",
    "- If a column name contains lower camelcase letters or special characters, quotes that identifier correctly for the current engine.",
    "- Prefer a single query.",
    "- For read requests, produce a read-only query.",
    "- Add LIMIT/TOP/FETCH when the user did not ask for all rows.",
    "- If the request is ambiguous, set needsClarification=true.",
    "- Never wrap JSON in markdown.",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await generateJson<Partial<AiPlan>>({
    endpoint: args.endpoint,
    model: args.model,
    prompt,
    onStatusChange: args.onStatusChange,
    signal: args.signal,
  });

  return {
    sql: normalizeQuotedIdentifiers({
      engine: args.engine,
      sql: String(raw?.sql ?? "").trim(),
      columnsByTable: args.columnsByTable,
    }).trim(),
    explanation: String(raw?.explanation ?? "").trim(),
    assumptions: Array.isArray(raw?.assumptions)
      ? raw.assumptions.map((item) => String(item)).filter(Boolean)
      : [],
    safety:
      raw?.safety === "read_only" ||
      raw?.safety === "mutating" ||
      raw?.safety === "unknown"
        ? raw.safety
        : "unknown",
    needsClarification: Boolean(raw?.needsClarification),
    clarification: String(raw?.clarification ?? "").trim(),
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
}) {
  const rows = queryResultToObjects(args.result, 50);
  const prompt = [
    "You answer database questions using only the executed result set below.",
    `Database engine: ${args.engine}`,
    `User question: ${args.question.trim()}`,
    `Executed SQL: ${args.sql.trim()}`,
    `Row count returned: ${Number(args.result.rowCount ?? rows.length)}`,
    `Columns: ${(args.result.columns ?? []).map((col) => col.name).join(", ")}`,
    "",
    "Rows JSON:",
    JSON.stringify(rows, null, 2),
    "",
    'Return JSON only with this exact shape: {"answer":"string","highlights":["string"],"confidence":"high|medium|low"}',
    "Rules:",
    "- Be precise and concise.",
    "- If the result is insufficient, say that clearly.",
    "- Do not invent values not present in the rows.",
  ].join("\n");

  const raw = await generateJson<Partial<AiAnswer>>({
    endpoint: args.endpoint,
    model: args.model,
    prompt,
    onStatusChange: args.onStatusChange,
    signal: args.signal,
  });

  return {
    answer: String(raw?.answer ?? "").trim(),
    highlights: Array.isArray(raw?.highlights)
      ? raw.highlights.map((item) => String(item)).filter(Boolean)
      : [],
    confidence:
      raw?.confidence === "high" ||
      raw?.confidence === "medium" ||
      raw?.confidence === "low"
        ? raw.confidence
        : "medium",
  } satisfies AiAnswer;
}

export function isGeneralChatPrompt(question: string) {
  const text = question.trim().toLowerCase();
  if (!text) return false;

  return [
    /^(hi|hello|hey|yo)\b/,
    /^(xin chao|chao|helo)\b/,
    /\b(ban la ai|ban giup duoc gi|ban lam duoc gi)\b/,
    /\b(who are you|what can you do|help me)\b/,
  ].some((pattern) => pattern.test(text));
}

export async function chatReply(args: {
  endpoint: string;
  model: string;
  engine: DatabaseEngine;
  question: string;
  activeSchema?: string;
  tables: TableItem[];
  onStatusChange?: (status: "loading_model" | "generating") => void;
  signal?: AbortSignal;
}) {
  const visibleTables = args.tables
    .filter((table) => !args.activeSchema || table.schema === args.activeSchema)
    .slice(0, 12)
    .map((table) => `${table.schema}.${table.name}`)
    .join(", ");

  const prompt = [
    "You are PoliteDB AI Assistant.",
    "You are a friendly local database copilot inside a desktop app.",
    `Database engine: ${args.engine}`,
    `Active schema or database: ${args.activeSchema || "(not selected)"}`,
    visibleTables ? `Visible tables: ${visibleTables}` : "",
    "",
    `User message: ${args.question.trim()}`,
    "",
    'Return JSON only with this exact shape: {"answer":"string","followup":"string"}',
    "Rules:",
    "- For casual greetings, respond naturally and briefly.",
    "- If the user is asking what you can do, explain you can answer database questions, suggest SQL, and analyze query results.",
    "- Do not invent data results.",
    "- Never wrap JSON in markdown.",
  ]
    .filter(Boolean)
    .join("\n");

  const raw = await generateJson<Partial<AiChatReply>>({
    endpoint: args.endpoint,
    model: args.model,
    prompt,
    onStatusChange: args.onStatusChange,
    signal: args.signal,
  });

  return {
    answer: String(raw?.answer ?? "").trim(),
    followup: String(raw?.followup ?? "").trim() || undefined,
  } satisfies AiChatReply;
}
