/**
 * SQL Constants - Shared between tokenizer and completion
 *
 * Organized by:
 * - Common (all engines)
 * - Engine-specific (PostgreSQL, MySQL, SQLite)
 *
 * Used by:
 * - registerSqlTheme.ts (tokenizer) - uses ALL_* for syntax highlighting
 * - sqlCompletion.ts (autocomplete) - uses engine-specific helpers
 */

import type { DatabaseEngine } from "src/types";

/* =========================
 * Common Keywords (All Engines)
 * ========================= */

export const SQL_KEYWORDS_COMMON = {
  dml: [
    "SELECT",
    "FROM",
    "WHERE",
    "JOIN",
    "LEFT",
    "RIGHT",
    "INNER",
    "OUTER",
    "FULL",
    "CROSS",
    "ON",
    "AND",
    "OR",
    "NOT",
    "IN",
    "EXISTS",
    "BETWEEN",
    "LIKE",
    "IS",
    "AS",
    "DISTINCT",
    "ALL",
    "ANY",
    "SOME",
  ],
  grouping: ["GROUP", "BY", "HAVING", "ORDER", "ASC", "DESC"],
  pagination: ["LIMIT", "OFFSET"],
  setOps: ["UNION", "INTERSECT", "EXCEPT"],
  mutation: ["INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE"],
  cte: ["WITH"],
  ddl: ["CREATE", "ALTER", "DROP", "TABLE", "VIEW", "INDEX", "DATABASE"],
  constraints: [
    "PRIMARY",
    "KEY",
    "FOREIGN",
    "REFERENCES",
    "UNIQUE",
    "CHECK",
    "DEFAULT",
    "CONSTRAINT",
    "CASCADE",
    "RESTRICT",
    "NULL",
  ],
  transaction: ["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT"],
  controlFlow: ["CASE", "WHEN", "THEN", "ELSE", "END"],
} as const;

/* =========================
 * PostgreSQL Specific
 * ========================= */

export const SQL_KEYWORDS_POSTGRES = {
  dml: ["ILIKE", "SIMILAR", "RETURNING"],
  pagination: ["FETCH", "NEXT", "ROWS", "ONLY"],
  cte: ["RECURSIVE"],
  ddl: [
    "SCHEMA",
    "SEQUENCE",
    "FUNCTION",
    "PROCEDURE",
    "TRIGGER",
    "TYPE",
    "EXTENSION",
    "MATERIALIZED",
  ],
  constraints: [
    "DEFERRABLE",
    "INITIALLY",
    "DEFERRED",
    "IMMEDIATE",
    "EXCLUDE",
    "USING",
    "GIST",
    "GIN",
  ],
  mutation: ["TRUNCATE", "ON CONFLICT", "DO NOTHING", "DO UPDATE"],
  window: [
    "OVER",
    "PARTITION",
    "WINDOW",
    "RANGE",
    "UNBOUNDED",
    "PRECEDING",
    "FOLLOWING",
    "CURRENT",
    "ROW",
    "ROWS",
  ],
  tableOptions: [
    "TEMPORARY",
    "TEMP",
    "UNLOGGED",
    "INHERITS",
    "TABLESPACE",
    "IF NOT EXISTS",
    "IF EXISTS",
  ],
  utility: ["EXPLAIN", "ANALYZE", "VACUUM", "REFRESH", "REINDEX", "COPY"],
  permissions: ["GRANT", "REVOKE", "ROLE", "USER", "PUBLIC"],
} as const;

export const SQL_FUNCTIONS_POSTGRES = {
  aggregate: [
    "ARRAY_AGG",
    "STRING_AGG",
    "JSON_AGG",
    "JSONB_AGG",
    "BOOL_AND",
    "BOOL_OR",
    "BIT_AND",
    "BIT_OR",
    "EVERY",
    "XMLAGG",
  ],
  window: [
    "ROW_NUMBER",
    "RANK",
    "DENSE_RANK",
    "NTILE",
    "LAG",
    "LEAD",
    "FIRST_VALUE",
    "LAST_VALUE",
    "NTH_VALUE",
    "PERCENT_RANK",
    "CUME_DIST",
  ],
  string: [
    "INITCAP",
    "SPLIT_PART",
    "REGEXP_REPLACE",
    "REGEXP_MATCH",
    "REGEXP_MATCHES",
    "FORMAT",
    "QUOTE_IDENT",
    "QUOTE_LITERAL",
    "TRANSLATE",
    "BTRIM",
    "LPAD",
    "RPAD",
  ],
  datetime: [
    "DATE_TRUNC",
    "DATE_PART",
    "EXTRACT",
    "AGE",
    "MAKE_DATE",
    "MAKE_TIME",
    "MAKE_TIMESTAMP",
    "MAKE_TIMESTAMPTZ",
    "TO_TIMESTAMP",
    "TO_DATE",
    "TO_CHAR",
    "TO_NUMBER",
    "CLOCK_TIMESTAMP",
    "STATEMENT_TIMESTAMP",
    "TRANSACTION_TIMESTAMP",
  ],
  json: [
    "JSON_BUILD_OBJECT",
    "JSON_BUILD_ARRAY",
    "JSONB_BUILD_OBJECT",
    "JSONB_BUILD_ARRAY",
    "JSON_EXTRACT_PATH",
    "JSON_EXTRACT_PATH_TEXT",
    "JSONB_EXTRACT_PATH",
    "JSONB_EXTRACT_PATH_TEXT",
    "JSONB_SET",
    "JSONB_INSERT",
    "JSONB_PRETTY",
    "JSON_TYPEOF",
    "JSONB_TYPEOF",
    "JSON_ARRAY_LENGTH",
    "JSONB_ARRAY_LENGTH",
    "JSON_EACH",
    "JSONB_EACH",
    "JSON_EACH_TEXT",
    "JSONB_EACH_TEXT",
    "JSON_OBJECT_KEYS",
    "JSONB_OBJECT_KEYS",
    "ROW_TO_JSON",
    "TO_JSON",
    "TO_JSONB",
    "JSON_POPULATE_RECORD",
    "JSONB_POPULATE_RECORD",
  ],
  array: [
    "ARRAY_LENGTH",
    "ARRAY_DIMS",
    "ARRAY_NDIMS",
    "ARRAY_UPPER",
    "ARRAY_LOWER",
    "ARRAY_APPEND",
    "ARRAY_PREPEND",
    "ARRAY_CAT",
    "ARRAY_REMOVE",
    "ARRAY_REPLACE",
    "ARRAY_POSITION",
    "ARRAY_TO_STRING",
    "STRING_TO_ARRAY",
    "UNNEST",
    "CARDINALITY",
  ],
  system: [
    "CURRENT_USER",
    "CURRENT_ROLE",
    "CURRENT_SCHEMA",
    "CURRENT_SCHEMAS",
    "CURRENT_DATABASE",
    "CURRENT_CATALOG",
    "SESSION_USER",
    "VERSION",
    "PG_TYPEOF",
    "PG_COLUMN_SIZE",
    "PG_DATABASE_SIZE",
    "PG_RELATION_SIZE",
    "PG_TABLE_SIZE",
    "PG_SIZE_PRETTY",
  ],
  sequence: ["NEXTVAL", "CURRVAL", "SETVAL", "LASTVAL"],
  other: ["GENERATE_SERIES", "GENERATE_SUBSCRIPTS"],
} as const;

export const SQL_TYPES_POSTGRES = {
  numeric: [
    "INT2",
    "INT4",
    "INT8",
    "FLOAT4",
    "FLOAT8",
    "SERIAL",
    "SMALLSERIAL",
    "BIGSERIAL",
    "MONEY",
  ],
  character: ["CITEXT", "NAME", "BPCHAR"],
  binary: ["BYTEA"],
  datetime: ["TIMESTAMPTZ", "TIMETZ", "INTERVAL"],
  json: ["JSON", "JSONB"],
  uuid: ["UUID"],
  network: ["INET", "CIDR", "MACADDR", "MACADDR8"],
  geometric: ["POINT", "LINE", "LSEG", "BOX", "PATH", "POLYGON", "CIRCLE"],
  textSearch: ["TSVECTOR", "TSQUERY"],
  range: [
    "INT4RANGE",
    "INT8RANGE",
    "NUMRANGE",
    "TSRANGE",
    "TSTZRANGE",
    "DATERANGE",
  ],
  other: ["XML", "OID", "REGCLASS", "REGTYPE", "REGPROC", "VOID", "RECORD"],
} as const;

/* =========================
 * MySQL Specific
 * ========================= */

export const SQL_KEYWORDS_MYSQL = {
  dml: ["RLIKE", "REGEXP", "SOUNDS LIKE", "STRAIGHT_JOIN"],
  mutation: [
    "IGNORE",
    "REPLACE",
    "ON DUPLICATE KEY UPDATE",
    "LOW_PRIORITY",
    "DELAYED",
    "HIGH_PRIORITY",
  ],
  ddl: ["ENGINE", "CHARSET", "COLLATE", "AUTO_INCREMENT", "COMMENT"],
  utility: ["SHOW", "DESCRIBE", "DESC", "USE", "FLUSH", "OPTIMIZE"],
  controlFlow: ["ELSEIF", "ITERATE", "LEAVE"],
  transaction: ["START TRANSACTION"],
  tableOptions: ["IF NOT EXISTS", "IF EXISTS", "TEMPORARY"],
} as const;

export const SQL_FUNCTIONS_MYSQL = {
  aggregate: ["GROUP_CONCAT", "JSON_ARRAYAGG", "JSON_OBJECTAGG"],
  string: [
    "INSTR",
    "LOCATE",
    "FIND_IN_SET",
    "FIELD",
    "ELT",
    "MAKE_SET",
    "LCASE",
    "UCASE",
    "MID",
    "SPACE",
    "STRCMP",
  ],
  datetime: [
    "DATE_FORMAT",
    "STR_TO_DATE",
    "DATEDIFF",
    "TIMEDIFF",
    "ADDDATE",
    "SUBDATE",
    "DATE_ADD",
    "DATE_SUB",
    "DAYNAME",
    "MONTHNAME",
    "DAYOFWEEK",
    "DAYOFMONTH",
    "DAYOFYEAR",
    "WEEK",
    "WEEKDAY",
    "YEARWEEK",
  ],
  conditional: ["IF", "IFNULL", "NVL"],
  json: [
    "JSON_EXTRACT",
    "JSON_UNQUOTE",
    "JSON_SET",
    "JSON_INSERT",
    "JSON_REMOVE",
    "JSON_REPLACE",
    "JSON_CONTAINS",
    "JSON_SEARCH",
    "JSON_KEYS",
    "JSON_LENGTH",
    "JSON_DEPTH",
    "JSON_TYPE",
  ],
  system: [
    "DATABASE",
    "USER",
    "CONNECTION_ID",
    "FOUND_ROWS",
    "LAST_INSERT_ID",
    "ROW_COUNT",
  ],
  encryption: ["MD5", "SHA1", "SHA2", "AES_ENCRYPT", "AES_DECRYPT"],
} as const;

export const SQL_TYPES_MYSQL = {
  numeric: ["TINYINT", "MEDIUMINT", "DOUBLE PRECISION"],
  character: ["TINYTEXT", "MEDIUMTEXT", "LONGTEXT"],
  binary: ["TINYBLOB", "MEDIUMBLOB", "LONGBLOB"],
  datetime: ["DATETIME", "YEAR"],
  other: ["ENUM", "SET", "JSON"],
} as const;

/* =========================
 * SQLite Specific
 * ========================= */

export const SQL_KEYWORDS_SQLITE = {
  dml: ["GLOB"],
  mutation: ["OR REPLACE", "OR IGNORE", "OR ABORT", "OR ROLLBACK", "OR FAIL"],
  utility: ["PRAGMA", "ATTACH", "DETACH", "REINDEX"],
  ddl: ["WITHOUT ROWID", "STRICT"],
} as const;

export const SQL_FUNCTIONS_SQLITE = {
  aggregate: ["GROUP_CONCAT", "TOTAL"],
  string: ["INSTR", "PRINTF", "GLOB", "LIKE"],
  datetime: ["DATE", "TIME", "DATETIME", "JULIANDAY", "STRFTIME"],
  other: [
    "TYPEOF",
    "LIKELY",
    "UNLIKELY",
    "ZEROBLOB",
    "LAST_INSERT_ROWID",
    "CHANGES",
    "TOTAL_CHANGES",
  ],
} as const;

/* =========================
 * Common Functions (All Engines)
 * ========================= */

export const SQL_FUNCTIONS_COMMON = {
  aggregate: ["COUNT", "SUM", "AVG", "MIN", "MAX"],
  string: [
    "CONCAT",
    "SUBSTRING",
    "SUBSTR",
    "TRIM",
    "LTRIM",
    "RTRIM",
    "UPPER",
    "LOWER",
    "LENGTH",
    "REPLACE",
    "LEFT",
    "RIGHT",
  ],
  numeric: [
    "ABS",
    "CEIL",
    "CEILING",
    "FLOOR",
    "ROUND",
    "TRUNC",
    "MOD",
    "POWER",
    "SQRT",
    "SIGN",
    "RANDOM",
    "LN",
    "LOG",
    "LOG10",
    "EXP",
  ],
  datetime: [
    "NOW",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "CURRENT_TIMESTAMP",
    "LOCALTIME",
    "LOCALTIMESTAMP",
  ],
  conditional: ["COALESCE", "NULLIF", "GREATEST", "LEAST"],
  typeConversion: ["CAST"],
} as const;

/* =========================
 * Common Types (All Engines)
 * ========================= */

export const SQL_TYPES_COMMON = {
  numeric: [
    "INT",
    "INTEGER",
    "SMALLINT",
    "BIGINT",
    "DECIMAL",
    "NUMERIC",
    "REAL",
    "FLOAT",
    "DOUBLE",
  ],
  character: ["CHAR", "VARCHAR", "TEXT"],
  binary: ["BLOB", "BINARY", "VARBINARY"],
  boolean: ["BOOLEAN", "BOOL"],
  datetime: ["DATE", "TIME", "TIMESTAMP"],
} as const;

/* =========================
 * Constants / Literals
 * ========================= */

export const SQL_CONSTANTS = [
  "TRUE",
  "FALSE",
  "NULL",
  "UNKNOWN",
  "DEFAULT",
] as const;

/* =========================
 * Operators
 * ========================= */

export const SQL_OPERATORS = {
  comparison: ["=", "<>", "!=", "<", ">", "<=", ">="],
  arithmetic: ["+", "-", "*", "/", "%", "^"],
  string: ["||"],
  postgres: [
    "::",
    "->",
    "->>",
    "#>",
    "#>>",
    "@>",
    "<@",
    "?",
    "?|",
    "?&",
    "~",
    "~*",
    "!~",
    "!~*",
    "@@",
    "&&",
    "@?",
  ],
  logical: ["AND", "OR", "NOT", "IN", "LIKE", "ILIKE", "SIMILAR TO", "BETWEEN"],
} as const;

/* =========================
 * Flattened arrays for tokenizer (all engines)
 * ========================= */

export const ALL_SQL_KEYWORDS = [
  ...Object.values(SQL_KEYWORDS_COMMON).flat(),
  ...Object.values(SQL_KEYWORDS_POSTGRES).flat(),
  ...Object.values(SQL_KEYWORDS_MYSQL).flat(),
  ...Object.values(SQL_KEYWORDS_SQLITE).flat(),
];

export const ALL_SQL_FUNCTIONS = [
  ...Object.values(SQL_FUNCTIONS_COMMON).flat(),
  ...Object.values(SQL_FUNCTIONS_POSTGRES).flat(),
  ...Object.values(SQL_FUNCTIONS_MYSQL).flat(),
  ...Object.values(SQL_FUNCTIONS_SQLITE).flat(),
];

export const ALL_SQL_TYPES = [
  ...Object.values(SQL_TYPES_COMMON).flat(),
  ...Object.values(SQL_TYPES_POSTGRES).flat(),
  ...Object.values(SQL_TYPES_MYSQL).flat(),
];

export const ALL_SQL_OPERATORS = [
  ...SQL_OPERATORS.comparison,
  ...SQL_OPERATORS.arithmetic,
  ...SQL_OPERATORS.string,
  ...SQL_OPERATORS.postgres,
];

/* =========================
 * Completion Keywords (structured for context detection)
 * ========================= */

type CompletionKeywords = {
  statement: readonly string[];
  clause: readonly string[];
  postFrom: readonly string[];
  postJoin: readonly string[];
  expression: readonly string[];
  values: readonly string[];
  orderBy: readonly string[];
};

const COMPLETION_KEYWORDS_BASE: CompletionKeywords = {
  statement: [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "WITH",
    "CREATE",
    "ALTER",
    "DROP",
  ],
  clause: [
    "FROM",
    "WHERE",
    "JOIN",
    "LEFT JOIN",
    "RIGHT JOIN",
    "INNER JOIN",
    "FULL JOIN",
    "CROSS JOIN",
    "ON",
    "AND",
    "OR",
    "GROUP BY",
    "ORDER BY",
    "HAVING",
    "LIMIT",
    "OFFSET",
    "UNION",
    "UNION ALL",
    "EXCEPT",
    "INTERSECT",
  ],
  postFrom: [
    "WHERE",
    "JOIN",
    "LEFT JOIN",
    "RIGHT JOIN",
    "INNER JOIN",
    "GROUP BY",
    "ORDER BY",
    "LIMIT",
    "HAVING",
  ],
  postJoin: [
    "ON",
    "WHERE",
    "JOIN",
    "LEFT JOIN",
    "RIGHT JOIN",
    "INNER JOIN",
    "GROUP BY",
    "ORDER BY",
  ],
  expression: [
    "AND",
    "OR",
    "NOT",
    "IN",
    "IS",
    "IS NOT",
    "NULL",
    "LIKE",
    "BETWEEN",
    "EXISTS",
    "CASE",
    "WHEN",
    "THEN",
    "ELSE",
    "END",
  ],
  values: ["TRUE", "FALSE", "NULL", "DEFAULT"],
  orderBy: ["ASC", "DESC", "NULLS FIRST", "NULLS LAST"],
};

const COMPLETION_KEYWORDS_POSTGRES: Partial<CompletionKeywords> = {
  statement: ["EXPLAIN", "ANALYZE", "COPY", "TRUNCATE"],
  clause: ["RETURNING", "FETCH FIRST", "ROWS ONLY"],
  expression: ["ILIKE", "SIMILAR TO"],
};

const COMPLETION_KEYWORDS_MYSQL: Partial<CompletionKeywords> = {
  statement: ["SHOW", "DESCRIBE", "USE", "REPLACE"],
  expression: ["RLIKE", "REGEXP"],
};

const COMPLETION_KEYWORDS_SQLITE: Partial<CompletionKeywords> = {
  statement: ["PRAGMA", "ATTACH", "DETACH"],
  expression: ["GLOB"],
};

/* =========================
 * Engine-specific helpers for completion
 * ========================= */

function mergeKeywords(
  base: CompletionKeywords,
  extra: Partial<CompletionKeywords>
): CompletionKeywords {
  return {
    statement: [...base.statement, ...(extra.statement ?? [])],
    clause: [...base.clause, ...(extra.clause ?? [])],
    postFrom: [...base.postFrom, ...(extra.postFrom ?? [])],
    postJoin: [...base.postJoin, ...(extra.postJoin ?? [])],
    expression: [...base.expression, ...(extra.expression ?? [])],
    values: [...base.values, ...(extra.values ?? [])],
    orderBy: [...base.orderBy, ...(extra.orderBy ?? [])],
  };
}

/**
 * Get completion keywords for specific engine
 */
export function getKeywordsForEngine(
  engine: DatabaseEngine = "postgres"
): CompletionKeywords {
  switch (engine) {
    case "postgres":
      return mergeKeywords(
        COMPLETION_KEYWORDS_BASE,
        COMPLETION_KEYWORDS_POSTGRES
      );
    case "mysql":
    case "mariadb":
      return mergeKeywords(COMPLETION_KEYWORDS_BASE, COMPLETION_KEYWORDS_MYSQL);
    case "sqlite":
      return mergeKeywords(
        COMPLETION_KEYWORDS_BASE,
        COMPLETION_KEYWORDS_SQLITE
      );
    default:
      return COMPLETION_KEYWORDS_BASE;
  }
}

/**
 * Get completion functions for specific engine
 */
export function getFunctionsForEngine(
  engine: DatabaseEngine = "postgres"
): string[] {
  const common = Object.values(SQL_FUNCTIONS_COMMON).flat();

  switch (engine) {
    case "postgres":
      return [...common, ...Object.values(SQL_FUNCTIONS_POSTGRES).flat()];
    case "mysql":
    case "mariadb":
      return [...common, ...Object.values(SQL_FUNCTIONS_MYSQL).flat()];
    case "sqlite":
      return [...common, ...Object.values(SQL_FUNCTIONS_SQLITE).flat()];
    default:
      return common;
  }
}

/**
 * Get types for specific engine
 */
export function getTypesForEngine(
  engine: DatabaseEngine = "postgres"
): string[] {
  const common = Object.values(SQL_TYPES_COMMON).flat();

  switch (engine) {
    case "postgres":
      return [...common, ...Object.values(SQL_TYPES_POSTGRES).flat()];
    case "mysql":
    case "mariadb":
      return [...common, ...Object.values(SQL_TYPES_MYSQL).flat()];
    default:
      return common;
  }
}

/* =========================
 * Legacy exports (backward compatible)
 * ========================= */

export const COMPLETION_KEYWORDS = COMPLETION_KEYWORDS_BASE;

export const COMPLETION_FUNCTIONS = [
  ...SQL_FUNCTIONS_COMMON.aggregate,
  ...SQL_FUNCTIONS_COMMON.string.slice(0, 8),
  ...SQL_FUNCTIONS_COMMON.datetime,
  ...SQL_FUNCTIONS_COMMON.conditional,
  "CAST",
  "TO_CHAR",
  "TO_DATE",
  "TO_NUMBER",
] as const;

export const ALL_COMPLETION_KEYWORDS = [
  ...COMPLETION_KEYWORDS_BASE.statement,
  ...COMPLETION_KEYWORDS_BASE.clause,
  ...COMPLETION_KEYWORDS_BASE.expression,
  ...COMPLETION_FUNCTIONS,
  ...COMPLETION_KEYWORDS_BASE.values,
];
