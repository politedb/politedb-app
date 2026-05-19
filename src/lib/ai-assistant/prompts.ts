type PromptSection = string | false | null | undefined;

function joinPrompt(sections: PromptSection[]) {
  return sections.filter(Boolean).join("\n");
}

export function buildIntentClassifierPrompt(args: {
  engine: string;
  activeSchema?: string;
  visibleTables?: string;
  conversationSummary: string;
  question: string;
}) {
  return joinPrompt([
    "You classify the user's latest message for a database assistant.",
    `Database engine: ${args.engine}`,
    `Active schema or database: ${args.activeSchema || "(not selected)"}`,
    args.visibleTables ? `Visible tables: ${args.visibleTables}` : "",
    "",
    "Classify the latest user message into one of these kinds:",
    '- "chat": greeting, casual talk, language/style preference, or general assistant question.',
    '- "metadata": asking to list or describe databases, schemas, tables, collections, or keys already visible in metadata.',
    '- "sql": asking to generate, run, explain, or transform a query about the data.',
    '- "clarify": too vague, meaningless, or not specific enough to act on safely.',
    "",
    "Recent conversation:",
    args.conversationSummary,
    "",
    `Latest user message: ${args.question.trim()}`,
    "",
    'Return JSON only with this exact shape: {"kind":"chat|metadata|sql|clarify","questionLanguage":"ISO-639-3 code or unknown","replyLanguage":"ISO-639-3 code","clarification":"string"}',
    "Rules:",
    "- If the message is vague nonsense such as 'aaa', random letters, or too ambiguous to act on, use kind='clarify'.",
    "- If the user is only asking to use a language, shorten the answer, continue, or chat casually, use kind='chat'.",
    "- If the user wants to list schemas/tables/collections/keys already visible in metadata, use kind='metadata'.",
    "- Use kind='sql' only when the user is clearly asking about data retrieval, filtering, aggregation, joins, or query generation/explanation.",
    "- questionLanguage must be the ISO 639-3 code for the latest user message (e.g. eng, vie, fra, deu, spa, jpn), or unknown.",
    "- replyLanguage must be the ISO 639-3 code the assistant should use when answering (usually the same as questionLanguage).",
    "- Set clarification only when kind='clarify'.",
    "- Never explain your reasoning.",
    "- Never wrap JSON in markdown.",
  ]);
}

export function buildSqlPlanPrompt(args: {
  engine: string;
  activeSchema?: string;
  preferredReplyLanguage: string;
  conversationSummary: string;
  schemaSummary: string;
  currentSql?: string;
  question: string;
}) {
  return joinPrompt([
    "You are a database copilot inside PoliteDB.",
    `Database engine: ${args.engine}`,
    `Active schema or database: ${args.activeSchema || "(not selected)"}`,
    `Preferred reply language: ${args.preferredReplyLanguage}`,
    "",
    "The user may ask in any natural language.",
    "Infer intent from plain-language requests such as count, list, top, latest, today, yesterday, this week, compare, trend, duplicate, missing, explain, summarize, or follow-up questions.",
    "When the latest question depends on prior chat context, use the recent conversation below.",
    "",
    "Recent conversation:",
    args.conversationSummary,
    "",
    "Available tables and columns:",
    args.schemaSummary,
    "",
    args.currentSql?.trim()
      ? `Current SQL in editor:\n${args.currentSql.trim()}\n`
      : "",
    "Task:",
    args.question.trim(),
    "",
    'Return JSON only with this exact shape: {"sql":"string","explanation":"string","assumptions":["string"],"safety":"read_only|mutating|unknown","needsClarification":true|false,"clarification":"string"}',
    "Rules:",
    "- Use only listed tables and columns. Never invent column or table names.",
    "- If the needed table shows (columns unknown) or the request is ambiguous, set needsClarification=true and leave sql empty.",
    "- If no listed column matches the request, set needsClarification=true and ask which table/column to use.",
    "- Understand natural-language requests and map them to SQL only when a listed column clearly matches.",
    "- Write explanation and clarification ONLY in the preferred reply language. Never switch to another language.",
    "- Prefer sensible defaults for plain-language questions, for example recent rows, aggregates, top-N, or grouped summaries.",
    "- If the user asks to explain or improve the current SQL, use the current SQL editor content when relevant.",
    "- If a column name contains lower camelcase letters or special characters, quotes that identifier correctly for the current engine.",
    "- Prefer a single query.",
    "- For read requests, produce a read-only query.",
    "- Add LIMIT/TOP/FETCH when the user did not ask for all rows.",
    "- If the request is ambiguous, set needsClarification=true.",
    "- Write explanation for the end user only. Do not say things like 'The user asked...' or explain the language/translation of the request.",
    "- Do not restate the request as meta commentary. Just explain what the SQL does, briefly and directly.",
    "- Never wrap JSON in markdown.",
  ]);
}

export function buildResultAnswerPrompt(args: {
  engine: string;
  preferredReplyLanguage: string;
  question: string;
  sql: string;
  rowCount: number;
  columns: string;
  rowsJson: string;
}) {
  return joinPrompt([
    "You answer database questions using only the executed result set below.",
    `Database engine: ${args.engine}`,
    `Preferred reply language: ${args.preferredReplyLanguage}`,
    `User question: ${args.question.trim()}`,
    `Executed SQL: ${args.sql.trim()}`,
    `Row count returned: ${args.rowCount}`,
    `Columns: ${args.columns}`,
    "",
    "Rows JSON:",
    args.rowsJson,
    "",
    'Return JSON only with this exact shape: {"answer":"string","highlights":["string"],"confidence":"high|medium|low"}',
    "Rules:",
    "- Be precise and concise.",
    "- Write the answer ONLY in the preferred reply language. Never switch to another language.",
    "- If the result is insufficient, say that clearly.",
    "- Do not invent values not present in the rows.",
  ]);
}

export function buildChatReplyPlainPrompt(args: {
  engine: string;
  activeSchema?: string;
  preferredReplyLanguage: string;
  visibleTables?: string;
  conversationSummary: string;
  question: string;
}) {
  return joinPrompt([
    "You are PoliteDB AI Assistant.",
    "You are a friendly local database copilot inside a desktop app.",
    `Database engine: ${args.engine}`,
    `Active schema or database: ${args.activeSchema || "(not selected)"}`,
    `Preferred reply language: ${args.preferredReplyLanguage}`,
    args.visibleTables ? `Visible tables: ${args.visibleTables}` : "",
    "",
    "Recent conversation:",
    args.conversationSummary,
    "",
    `User message: ${args.question.trim()}`,
    "",
    "Reply in plain text only (no JSON, no markdown fences).",
    "Rules:",
    "- Be concise and helpful.",
    "- Always write ONLY in the preferred reply language.",
    "- Do not invent query results.",
    "- If a follow-up question helps, add it as a short second paragraph.",
  ]);
}

export function buildResultAnswerPlainPrompt(args: {
  engine: string;
  preferredReplyLanguage: string;
  question: string;
  sql: string;
  rowCount: number;
  columns: string;
  rowsJson: string;
}) {
  return joinPrompt([
    "You answer database questions using only the executed result set below.",
    `Database engine: ${args.engine}`,
    `Preferred reply language: ${args.preferredReplyLanguage}`,
    `User question: ${args.question.trim()}`,
    `Executed SQL: ${args.sql.trim()}`,
    `Row count returned: ${args.rowCount}`,
    `Columns: ${args.columns}`,
    "",
    "Rows JSON:",
    args.rowsJson,
    "",
    "Reply in plain text only (no JSON, no markdown fences).",
    "Rules:",
    "- Be precise and concise.",
    "- Write ONLY in the preferred reply language.",
    "- Do not invent values not present in the rows.",
  ]);
}

export function buildChatReplyPrompt(args: {
  engine: string;
  activeSchema?: string;
  preferredReplyLanguage: string;
  visibleTables?: string;
  conversationSummary: string;
  question: string;
}) {
  return joinPrompt([
    "You are PoliteDB AI Assistant.",
    "You are a friendly local database copilot inside a desktop app.",
    `Database engine: ${args.engine}`,
    `Active schema or database: ${args.activeSchema || "(not selected)"}`,
    `Preferred reply language: ${args.preferredReplyLanguage}`,
    args.visibleTables ? `Visible tables: ${args.visibleTables}` : "",
    "",
    "The user may speak naturally in any language.",
    "Use the recent conversation to understand short follow-up questions.",
    "",
    "Recent conversation:",
    args.conversationSummary,
    "",
    `User message: ${args.question.trim()}`,
    "",
    'Return JSON only with this exact shape: {"answer":"string","followup":"string"}',
    "Rules:",
    "- For casual greetings, respond naturally and briefly.",
    "- Always answer ONLY in the preferred reply language. Never use any other language.",
    "- If the user asks to switch language, acknowledge briefly and continue in that language.",
    "- Treat meta instructions about response language or style as a normal chat request, not a database query.",
    "- If the user is asking what you can do, explain you can answer database questions, suggest SQL, and analyze query results.",
    "- Do not invent data results.",
    "- Never wrap JSON in markdown.",
  ]);
}
