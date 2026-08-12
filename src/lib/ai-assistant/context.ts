import type { AiColumnMetadata, DatabaseEngine, TableItem } from "src/types";

export type AssistantScope = "global" | "connection" | "sql_editor";

export type AssistantContext = {
  scope: AssistantScope;
  engine: DatabaseEngine;
  activeSchema?: string;
  tableCount: number;
  hasCurrentSql: boolean;
};

export function buildAssistantContext(args: {
  engine: DatabaseEngine;
  runtimeConnectionId?: string;
  activeSchema?: string;
  activeTable?: TableItem;
  tables: TableItem[];
  currentSql?: string;
}): AssistantContext {
  const hasCurrentSql = Boolean(args.currentSql?.trim());
  const hasConnectionContext = Boolean(
    args.runtimeConnectionId || args.activeSchema || args.tables.length
  );

  return {
    scope: !hasConnectionContext
      ? "global"
      : hasCurrentSql
        ? "sql_editor"
        : "connection",
    engine: args.engine,
    activeSchema: args.activeSchema,
    tableCount: args.tables.length + (args.activeTable ? 1 : 0),
    hasCurrentSql,
  };
}

export function hasConcreteDatabaseContext(context: AssistantContext) {
  return context.scope !== "global";
}

export function getAssistantScopeInstruction(context: AssistantContext) {
  if (context.scope === "global") {
    return [
      "Context scope: global app assistant.",
      "No active database schema is available.",
      "Answer general questions normally.",
      "Do not claim that a table, column, row, query result, index, function, trigger, or schema exists.",
      "For database-specific work, ask the user to open a connection or attach schema context with @.",
      "Only provide SQL as a generic template when the user explicitly asks for a template/example.",
    ].join("\n");
  }

  if (context.scope === "sql_editor") {
    return [
      "Context scope: active SQL editor.",
      "Use the current SQL and visible metadata when relevant.",
      "Generated SQL is preview-only. The app will ask the user before running it.",
    ].join("\n");
  }

  return [
    "Context scope: active database connection.",
    "Use only visible schema metadata.",
    "Generated SQL is preview-only. The app will ask the user before running it.",
  ].join("\n");
}

export function isDatabaseSpecificRequest(question: string) {
  const text = normalizeForAssistantContext(question);
  if (!text) return false;

  if (
    /\b(generic|template|example|syntax|sample|mau|vi du|cu phap)\b/.test(text)
  ) {
    return false;
  }

  return [
    /\b(sql|query|table|column|schema|database|db|row|rows|record|records|index|migration)\b/,
    /\b(select|insert|update|delete|truncate|drop|alter|create|count|list|show|find|get|fetch|filter|join|group|order)\b/,
    /\b(lay|cho toi|hien thi|liet ke|dem|tim|truy van|bang|cot|dong|ban ghi|du lieu|loc|sap xep|migration)\b/,
  ].some((pattern) => pattern.test(text));
}

export function formatMissingDatabaseContextReply(args: {
  question: string;
  replyLanguageCode: string;
}) {
  if (args.replyLanguageCode === "vie") {
    return [
      "Mình chưa có connection/schema active nên không biết bảng và cột thật.",
      "Hãy mở một connection hoặc gõ @ để thêm Visible schema metadata. Nếu bạn chỉ muốn SQL mẫu, nói rõ table/columns cần dùng.",
    ].join("\n\n");
  }

  return [
    "I do not have an active connection or schema yet, so I cannot know the real tables and columns.",
    "Open a connection or use @ to attach visible schema metadata. If you only want a generic SQL template, include the table and column names.",
  ].join("\n\n");
}

export function selectRelevantSchema(args: {
  question: string;
  activeSchema?: string;
  activeTable?: TableItem;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  columnDetailsByTable?: Record<string, AiColumnMetadata[]>;
  maxTables?: number;
  maxColumnsPerTable?: number;
}) {
  const {
    question,
    activeSchema,
    activeTable,
    tables,
    columnsByTable = {},
    columnDetailsByTable = {},
    maxTables = 16,
    maxColumnsPerTable = 24,
  } = args;

  const visibleTables = tables.filter(
    (table) => !activeSchema || table.schema === activeSchema
  );
  if (
    activeTable &&
    (!activeSchema || activeTable.schema === activeSchema) &&
    !visibleTables.some(
      (table) =>
        table.schema === activeTable.schema && table.name === activeTable.name
    )
  ) {
    visibleTables.unshift(activeTable);
  }
  const activeTableKey = activeTable
    ? `${activeTable.schema}.${activeTable.name}`
    : "";
  const normalizedQuestion = normalizeForAssistantContext(question);
  const tokens = new Set(tokenize(question));

  const ranked = visibleTables
    .map((table) => {
      const key = `${table.schema}.${table.name}`;
      const columns = columnsByTable[key] ?? [];
      const details = columnDetailsByTable[key] ?? [];
      const searchable = [
        table.schema,
        table.name,
        table.comment,
        table.kind,
        columns.join(" "),
      ]
        .filter(Boolean)
        .join(" ");
      const haystack = normalizeForAssistantContext(searchable);
      const normalizedName = normalizeForAssistantContext(table.name);
      const normalizedKey = normalizeForAssistantContext(key);
      const exactTableMention =
        normalizedQuestion.includes(normalizedKey) ||
        new RegExp(
          `(^|[^a-z0-9_])${escapeRegExp(normalizedName)}([^a-z0-9_]|$)`
        ).test(normalizedQuestion);
      const exactColumnMatches = columns.filter((column) =>
        new RegExp(
          `(^|[^a-z0-9_])${escapeRegExp(normalizeForAssistantContext(column))}([^a-z0-9_]|$)`
        ).test(normalizedQuestion)
      ).length;
      const score =
        Array.from(tokens).reduce(
          (acc, token) => acc + (haystack.includes(token) ? 1 : 0),
          0
        ) +
        (exactTableMention ? 20 : 0) +
        exactColumnMatches * 4 +
        (activeSchema && table.schema === activeSchema ? 0.25 : 0) +
        (`${table.schema}.${table.name}` === activeTableKey &&
        !exactTableMention
          ? 1
          : 0);
      return { table, score, columns, details };
    })
    .sort(
      (a, b) => b.score - a.score || a.table.name.localeCompare(b.table.name)
    );

  const selected = ranked.some((item) => item.score > 0)
    ? ranked.slice(0, maxTables)
    : ranked.slice(0, Math.min(maxTables, 24));

  const selectedColumns = selected.reduce<Record<string, string[]>>(
    (acc, item) => {
      const key = `${item.table.schema}.${item.table.name}`;
      acc[key] = item.columns.slice(0, maxColumnsPerTable);
      return acc;
    },
    {}
  );
  const selectedColumnDetails = selected.reduce<
    Record<string, AiColumnMetadata[]>
  >((acc, item) => {
    const key = `${item.table.schema}.${item.table.name}`;
    acc[key] = item.details.slice(0, maxColumnsPerTable);
    return acc;
  }, {});

  return {
    tables: selected.map((item) => item.table),
    columnsByTable: selectedColumns,
    columnDetailsByTable: selectedColumnDetails,
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeForAssistantContext(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/đ/g, "d")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string) {
  return normalizeForAssistantContext(value)
    .split(/[^a-z0-9_]+/g)
    .map((item) => item.trim())
    .filter((item) => item.length >= 2);
}
