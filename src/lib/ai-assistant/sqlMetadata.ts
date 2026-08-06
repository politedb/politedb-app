import type { DatabaseEngine, TableItem } from "src/types";
import type { ReplyLanguageInfo } from "./language";
import { supportsLocalizedFastPath } from "./language";

const SQL_KEYWORDS = new Set(
  [
    "select",
    "from",
    "where",
    "join",
    "inner",
    "left",
    "right",
    "full",
    "cross",
    "on",
    "and",
    "or",
    "not",
    "in",
    "is",
    "null",
    "as",
    "by",
    "group",
    "order",
    "having",
    "limit",
    "offset",
    "distinct",
    "union",
    "all",
    "case",
    "when",
    "then",
    "else",
    "end",
    "true",
    "false",
    "between",
    "like",
    "ilike",
    "exists",
    "into",
    "values",
    "set",
    "with",
    "asc",
    "desc",
    "max",
    "min",
    "sum",
    "avg",
    "count",
    "coalesce",
    "cast",
    "over",
    "partition",
    "fetch",
    "top",
    "public",
  ].map((item) => item.toLowerCase())
);

export type SqlMetadataIssue = {
  kind: "unknown_table" | "unknown_column" | "columns_not_loaded";
  table: string;
  column?: string;
  availableColumns?: string[];
};

export type SqlMetadataValidation = {
  ok: boolean;
  issues: SqlMetadataIssue[];
};

function unquoteIdentifier(value: string) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`")) ||
    (trimmed.startsWith("[") && trimmed.endsWith("]"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function stripSqlStringsAndComments(sql: string) {
  return sql
    .replace(/'(?:''|[^'])*'/g, " ")
    .replace(/"(?:\"\"|[^"])*"/g, " ")
    .replace(/--[^\n\r]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ");
}

function resolveTableKey(
  ref: { schema?: string; name: string },
  tables: TableItem[],
  activeSchema?: string
) {
  const name = ref.name.toLowerCase();
  if (ref.schema) {
    const schema = ref.schema.toLowerCase();
    const exact = tables.find(
      (table) =>
        table.name.toLowerCase() === name &&
        table.schema.toLowerCase() === schema
    );
    if (exact) return `${exact.schema}.${exact.name}`;
  }

  const matches = tables.filter((table) => table.name.toLowerCase() === name);
  if (!matches.length) return null;
  if (activeSchema) {
    const preferred = matches.find(
      (table) => table.schema.toLowerCase() === activeSchema.toLowerCase()
    );
    if (preferred) return `${preferred.schema}.${preferred.name}`;
  }
  if (matches.length === 1) return `${matches[0]!.schema}.${matches[0]!.name}`;
  return `${matches[0]!.schema}.${matches[0]!.name}`;
}

export function extractTablesFromSql(sql: string) {
  const cleaned = stripSqlStringsAndComments(sql);
  const refs: Array<{ schema?: string; name: string }> = [];
  const pattern =
    /\b(?:from|join)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|\w+))?)/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned))) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    const parts = raw.split(/\s*\.\s*/).map((part) => unquoteIdentifier(part));
    if (parts.length >= 2) {
      refs.push({
        schema: parts[parts.length - 2],
        name: parts[parts.length - 1]!,
      });
    } else if (parts[0]) {
      refs.push({ name: parts[0] });
    }
  }

  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.schema ?? ""}.${ref.name}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractColumnsReferencedForTable(
  sql: string,
  tableRef: { schema?: string; name: string },
  singleTableQuery: boolean
) {
  const cleaned = stripSqlStringsAndComments(sql);
  const columns = new Set<string>();
  const tableName = tableRef.name;
  const schema = tableRef.schema;

  const qualifiedPatterns: RegExp[] = [];
  if (schema) {
    qualifiedPatterns.push(
      new RegExp(
        `\\b${escapeRegExp(schema)}\\.${escapeRegExp(tableName)}\\.("?)([a-zA-Z_][a-zA-Z0-9_]*)\\1\\b`,
        "gi"
      )
    );
  }
  qualifiedPatterns.push(
    new RegExp(
      `\\b${escapeRegExp(tableName)}\\.("?)([a-zA-Z_][a-zA-Z0-9_]*)\\1\\b`,
      "gi"
    )
  );

  for (const pattern of qualifiedPatterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(cleaned))) {
      const col = match[2];
      if (col && !SQL_KEYWORDS.has(col.toLowerCase())) {
        columns.add(col);
      }
    }
  }

  const aggregatePattern =
    /\b(?:max|min|sum|avg|count)\s*\(\s*(?:distinct\s+)?(?!\*)(?:"([^"]+)"|`([^`]+)`|([a-zA-Z_][a-zA-Z0-9_]*))\s*\)/gi;
  let aggregateMatch: RegExpExecArray | null;
  while ((aggregateMatch = aggregatePattern.exec(cleaned))) {
    const col =
      aggregateMatch[1] ?? aggregateMatch[2] ?? aggregateMatch[3] ?? "";
    if (col && !SQL_KEYWORDS.has(col.toLowerCase())) {
      columns.add(col);
    }
  }

  if (singleTableQuery) {
    const clausePattern =
      /\b(?:where|on|group\s+by|order\s+by|having)\s+([^;]+?)(?=\b(?:group\s+by|order\s+by|having|limit|offset|fetch|for)\b|$)/gi;
    let clauseMatch: RegExpExecArray | null;
    while ((clauseMatch = clausePattern.exec(cleaned))) {
      const clause = clauseMatch[1] ?? "";
      const identifierPattern = /\b("?)([a-zA-Z_][a-zA-Z0-9_]*)\1\b/g;
      let identifierMatch: RegExpExecArray | null;
      while ((identifierMatch = identifierPattern.exec(clause))) {
        const col = identifierMatch[2] ?? "";
        const lower = col.toLowerCase();
        if (
          !col ||
          SQL_KEYWORDS.has(lower) ||
          lower === tableName.toLowerCase() ||
          (schema && lower === schema.toLowerCase())
        ) {
          continue;
        }
        columns.add(col);
      }
    }
  }

  return Array.from(columns);
}

function columnExists(columns: string[], column: string) {
  const target = column.toLowerCase();
  return columns.some((item) => item.toLowerCase() === target);
}

export function validateSqlAgainstMetadata(args: {
  sql: string;
  tables: TableItem[];
  columnsByTable?: Record<string, string[]>;
  activeSchema?: string;
}): SqlMetadataValidation {
  const columnsByTable = args.columnsByTable ?? {};
  const tableRefs = extractTablesFromSql(args.sql);
  const issues: SqlMetadataIssue[] = [];

  if (!args.tables.length || !tableRefs.length) {
    return { ok: true, issues };
  }

  const resolvedTables = tableRefs
    .map((ref) => ({
      ref,
      key: resolveTableKey(ref, args.tables, args.activeSchema),
    }))
    .filter((item): item is { ref: (typeof tableRefs)[0]; key: string } =>
      Boolean(item.key)
    );

  for (const ref of tableRefs) {
    const key = resolveTableKey(ref, args.tables, args.activeSchema);
    if (!key) {
      issues.push({
        kind: "unknown_table",
        table: ref.schema ? `${ref.schema}.${ref.name}` : ref.name,
      });
    }
  }

  const singleTableQuery = resolvedTables.length === 1;

  for (const { ref, key } of resolvedTables) {
    const knownColumns = columnsByTable[key] ?? [];
    if (!knownColumns.length) {
      // Column list not loaded yet — skip validation and allow execution.
      continue;
    }

    const referenced = extractColumnsReferencedForTable(
      args.sql,
      ref,
      singleTableQuery
    );

    for (const column of referenced) {
      if (!columnExists(knownColumns, column)) {
        issues.push({
          kind: "unknown_column",
          table: key,
          column,
          availableColumns: knownColumns,
        });
      }
    }
  }

  return { ok: issues.length === 0, issues };
}

function formatColumnPreview(columns: string[], maxItems = 12) {
  if (columns.length <= maxItems) return columns.join(", ");
  return `${columns.slice(0, maxItems).join(", ")} (+${columns.length - maxItems} more)`;
}

export function formatSqlValidationIssues(
  issues: SqlMetadataIssue[],
  lang: ReplyLanguageInfo
) {
  const vi = lang.code === "vie";
  const useLocalized = supportsLocalizedFastPath(lang);
  const lines: string[] = [];

  for (const issue of issues) {
    if (issue.kind === "unknown_table") {
      lines.push(
        useLocalized
          ? vi
            ? `Không tìm thấy bảng ${issue.table} trong metadata đã tải.`
            : `Table ${issue.table} was not found in the loaded metadata.`
          : `Table ${issue.table} was not found in the loaded metadata.`
      );
      continue;
    }

    if (issue.kind === "columns_not_loaded") {
      lines.push(
        useLocalized
          ? vi
            ? `Chưa có danh sách cột cho bảng ${issue.table}. Hãy mở bảng này ở sidebar hoặc đợi metadata tải xong, rồi hỏi lại.`
            : `Column metadata for ${issue.table} is not loaded yet. Open that table in the sidebar or wait for metadata to finish loading, then try again.`
          : `Column metadata for ${issue.table} is not loaded yet. Open that table in the sidebar or wait for metadata to finish loading, then try again.`
      );
      continue;
    }

    const available = issue.availableColumns ?? [];
    lines.push(
      useLocalized
        ? vi
          ? `Cột ${issue.column} không tồn tại trong ${issue.table}.${available.length ? ` Các cột hiện có: ${formatColumnPreview(available)}.` : ""}`
          : `Column ${issue.column} does not exist on ${issue.table}.${available.length ? ` Available columns: ${formatColumnPreview(available)}.` : ""}`
        : `Column ${issue.column} does not exist on ${issue.table}.${available.length ? ` Available columns: ${formatColumnPreview(available)}.` : ""}`
    );
  }

  const header = useLocalized
    ? vi
      ? "Tôi chưa chạy truy vấn vì có thể không khớp schema hiện tại:"
      : "I did not run the query because it may not match the current schema:"
    : "I did not run the query because it may not match the current schema:";

  const footer = useLocalized
    ? vi
      ? "Hãy chọn đúng bảng/cột hoặc mô tả lại câu hỏi cụ thể hơn."
      : "Pick the correct table/column or rephrase your question with exact names."
    : "Pick the correct table/column or rephrase your question with exact names.";

  return [header, ...lines.map((line) => `- ${line}`), footer].join("\n");
}

export function parseDatabaseExecutionError(message: string) {
  const columnMatch =
    /column\s+"([^"]+)"\s+does not exist/i.exec(message) ??
    /column\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+does not exist/i.exec(message);
  if (columnMatch?.[1]) {
    return { kind: "unknown_column" as const, column: columnMatch[1] };
  }

  const relationMatch =
    /relation\s+"([^"]+)"\s+does not exist/i.exec(message) ??
    /table\s+"([^"]+)"\s+does not exist/i.exec(message);
  if (relationMatch?.[1]) {
    return { kind: "unknown_table" as const, table: relationMatch[1] };
  }

  return null;
}

export function formatSqlExecutionError(args: {
  error: unknown;
  lang: ReplyLanguageInfo;
  sql?: string;
  tables?: TableItem[];
  columnsByTable?: Record<string, string[]>;
  activeSchema?: string;
  engine?: DatabaseEngine;
}) {
  const raw =
    args.error instanceof Error ? args.error.message : String(args.error ?? "");
  const vi = args.lang.code === "vie";
  const useLocalized = supportsLocalizedFastPath(args.lang);
  const parsed = parseDatabaseExecutionError(raw);

  if (parsed?.kind === "unknown_column") {
    const tables = extractTablesFromSql(args.sql ?? "");
    const hints: string[] = [];

    for (const ref of tables) {
      const key = resolveTableKey(ref, args.tables ?? [], args.activeSchema);
      if (!key) continue;
      const cols = args.columnsByTable?.[key] ?? [];
      if (cols.length) {
        hints.push(`${key}: ${formatColumnPreview(cols)}`);
      }
    }

    if (useLocalized) {
      return vi
        ? `Truy vấn thất bại vì cột "${parsed.column}" không tồn tại.${hints.length ? `\n\nCác cột gợi ý:\n${hints.map((line) => `- ${line}`).join("\n")}` : ""}\n\nHãy chọn đúng tên cột rồi thử lại.`
        : `The query failed because column "${parsed.column}" does not exist.${hints.length ? `\n\nAvailable columns:\n${hints.map((line) => `- ${line}`).join("\n")}` : ""}\n\nUse an existing column name and try again.`;
    }

    return `The query failed because column "${parsed.column}" does not exist.${hints.length ? `\n\nAvailable columns:\n${hints.map((line) => `- ${line}`).join("\n")}` : ""}\n\nUse an existing column name and try again.`;
  }

  if (parsed?.kind === "unknown_table") {
    if (useLocalized) {
      return vi
        ? `Truy vấn thất bại vì không tìm thấy bảng "${parsed.table}". Kiểm tra tên bảng trong sidebar rồi thử lại.`
        : `The query failed because table "${parsed.table}" does not exist. Check the table name in the sidebar and try again.`;
    }
    return `The query failed because table "${parsed.table}" does not exist. Check the table name in the sidebar and try again.`;
  }

  if (useLocalized) {
    return vi
      ? `Không thể chạy truy vấn: ${raw}`
      : `Could not run the query: ${raw}`;
  }

  return `Could not run the query: ${raw}`;
}
