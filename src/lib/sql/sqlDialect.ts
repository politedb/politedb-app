import type { DatabaseEngine } from "src/types";
import { isPostgresArrayType, pgArrayValueSql } from "./pgArrayLiteral";
import { decodeBytesB64 } from "src/utils/convert";
import { isSqliteLike } from "src/utils/sqliteLike";

export function isSqlServerEngine(engine?: DatabaseEngine) {
  return engine === "sqlserver";
}

export function isMysqlFamilyEngine(engine?: DatabaseEngine) {
  return engine === "mysql" || engine === "mariadb" || engine === "clickhouse";
}

export function isJsonColumnType(dbType: string | undefined): boolean {
  if (!dbType || typeof dbType !== "string") return false;
  return /\bjsonb?\b/i.test(dbType.trim());
}

export function isBlobColumnType(dbType: string | undefined): boolean {
  if (!dbType || typeof dbType !== "string") return false;
  return /\b(tinyblob|mediumblob|longblob|blob|binary|varbinary|bytea|raw|long raw|image)\b/i.test(
    dbType.trim()
  );
}

import {
  clickhouseDecimalScale,
  formatClickhouseDecimalForSql,
} from "../engines/clickhouse";

export {
  clickhouseDecimalScale,
  formatClickhouseDecimalForSql,
  normalizeClickhouseDbType,
  unwrapClickhouseType,
} from "../engines/clickhouse";

export function isNumericColumnType(dbType: string | undefined): boolean {
  if (!dbType || typeof dbType !== "string") return false;
  const t = dbType.trim();
  return (
    /^(bit|tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial|float|double|float4|float8|real|double\s*precision|numeric|decimal)(\s*\([^)]*\))?(\s+unsigned)?$/i.test(
      t
    ) ||
    /^(u?int(8|16|32|64|128|256)?|float32|float64)(?:\s*\([^)]*\))?$/i.test(t)
  );
}

export function quoteIdentifier(ident: string, engine?: DatabaseEngine) {
  const value = String(ident);
  if (isMysqlFamilyEngine(engine)) {
    return `\`${value.replace(/`/g, "``")}\``;
  }
  if (isSqlServerEngine(engine)) {
    return `[${value.replace(/]/g, "]]")}]`;
  }
  return `"${value.replace(/"/g, `""`)}"`;
}

export function quoteTableName(
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) {
  if (isSqliteLike(engine) || !schema) {
    return quoteIdentifier(tableName, engine);
  }
  return `${quoteIdentifier(schema, engine)}.${quoteIdentifier(tableName, engine)}`;
}

export function unsupportedSql(
  feature: string,
  engine?: DatabaseEngine
): never {
  throw new Error(
    `${feature} is not supported for ${engine ?? "this database"} yet.`
  );
}

export function createTableSql(
  schema: string,
  tableName: string,
  columnDefinitions: string[],
  primaryKeyColumns: string[] = [],
  engine?: DatabaseEngine
) {
  const primaryKeyConstraint = primaryKeyColumns.length
    ? `,\n      PRIMARY KEY (${primaryKeyColumns
        .map((key) => quoteIdentifier(key, engine))
        .join(", ")})`
    : "";

  return `
    CREATE TABLE ${quoteTableName(schema, tableName, engine)} (
      ${columnDefinitions.join(",\n      ")}${primaryKeyConstraint}
    );
  `;
}

export function copyTableDataSql(
  schema: string,
  tableName: string,
  newTableName: string,
  engine?: DatabaseEngine
) {
  return `INSERT INTO ${quoteTableName(schema, newTableName, engine)} SELECT * FROM ${quoteTableName(schema, tableName, engine)};`;
}

export function cloneTableSql(
  schema: string,
  tableName: string,
  newTableName: string,
  engine?: DatabaseEngine
) {
  const source = quoteTableName(schema, tableName, engine);
  const target = quoteTableName(schema, newTableName, engine);

  if (isMysqlFamilyEngine(engine)) {
    return `CREATE TABLE ${target} LIKE ${source};`;
  }

  if (isSqliteLike(engine)) {
    return `CREATE TABLE ${target} AS SELECT * FROM ${source} WHERE 0;`;
  }

  if (engine === "postgres" || !engine) {
    return `CREATE TABLE ${target} (LIKE ${source} INCLUDING ALL);`;
  }

  unsupportedSql("Clone table", engine);
}

export function dropTableSql(
  schema: string,
  tableName: string,
  engine?: DatabaseEngine
) {
  return `DROP TABLE ${quoteTableName(schema, tableName, engine)};`;
}

/** ClickHouse row updates use `ALTER TABLE ... UPDATE`, not standard SQL `UPDATE`. */
export function clickhouseUpdateSql(
  schema: string,
  tableName: string,
  assignments: string[],
  whereClauses: string[]
) {
  const table = quoteTableName(schema, tableName, "clickhouse");
  return `ALTER TABLE ${table} UPDATE ${assignments.join(", ")} WHERE ${whereClauses.join(" AND ")};`;
}

/** ClickHouse row deletes use `ALTER TABLE ... DELETE`, not `DELETE FROM`. */
export function clickhouseDeleteSql(
  schema: string,
  tableName: string,
  whereClauses: string[]
) {
  const table = quoteTableName(schema, tableName, "clickhouse");
  return `ALTER TABLE ${table} DELETE WHERE ${whereClauses.join(" AND ")};`;
}

export function renameTableSql(
  schema: string,
  tableName: string,
  newTableName: string,
  engine?: DatabaseEngine
) {
  if (isMysqlFamilyEngine(engine)) {
    return `RENAME TABLE ${quoteTableName(schema, tableName, engine)} TO ${quoteTableName(schema, newTableName, engine)};`;
  }

  if (engine === "sqlserver") {
    return `EXEC sp_rename ${sqlStringLiteral(`${schema}.${tableName}`, engine)}, ${sqlStringLiteral(newTableName, engine)};`;
  }

  return `ALTER TABLE ${quoteTableName(schema, tableName, engine)} RENAME TO ${quoteIdentifier(newTableName, engine)};`;
}

export function truncateTableSql(
  schema: string,
  tableName: string,
  opts?: { restartIdentity?: boolean; cascade?: boolean },
  engine?: DatabaseEngine
) {
  const table = quoteTableName(schema, tableName, engine);

  if (isSqliteLike(engine)) {
    return `DELETE FROM ${table};`;
  }

  if (isMysqlFamilyEngine(engine)) {
    return `TRUNCATE TABLE ${table};`;
  }

  if (engine === "sqlserver") {
    return `TRUNCATE TABLE ${table};`;
  }

  const parts = ["TRUNCATE TABLE", table];
  if (opts?.restartIdentity) {
    parts.push("RESTART IDENTITY");
  }
  parts.push(opts?.cascade !== false ? "CASCADE" : "RESTRICT");
  return `${parts.join(" ")};`;
}

export function renameColumnSql(
  schema: string,
  tableName: string,
  oldName: string,
  newName: string,
  engine?: DatabaseEngine
) {
  if (engine === "sqlserver") {
    return `EXEC sp_rename ${sqlStringLiteral(`${schema}.${tableName}.${oldName}`, engine)}, ${sqlStringLiteral(newName, engine)}, 'COLUMN';`;
  }

  if (engine === "oracle") {
    return `ALTER TABLE ${quoteTableName(schema, tableName, engine)} RENAME COLUMN ${quoteIdentifier(oldName, engine)} TO ${quoteIdentifier(newName, engine)};`;
  }

  return `ALTER TABLE ${quoteTableName(schema, tableName, engine)} RENAME COLUMN ${quoteIdentifier(oldName, engine)} TO ${quoteIdentifier(newName, engine)};`;
}

export function addColumnSql(
  schema: string,
  tableName: string,
  columnDefinition: string,
  engine?: DatabaseEngine
) {
  const keyword =
    engine === "sqlserver" || engine === "oracle" ? "ADD" : "ADD COLUMN";
  return `ALTER TABLE ${quoteTableName(schema, tableName, engine)} ${keyword} ${columnDefinition};`;
}

export function dropColumnSql(
  schema: string,
  tableName: string,
  columnName: string,
  engine?: DatabaseEngine
) {
  return `ALTER TABLE ${quoteTableName(schema, tableName, engine)} DROP COLUMN ${quoteIdentifier(columnName, engine)};`;
}

export function dropPrimaryKeySql(
  schema: string,
  tableName: string,
  constraintName: string,
  engine?: DatabaseEngine
) {
  const table = quoteTableName(schema, tableName, engine);
  if (isMysqlFamilyEngine(engine)) {
    return `ALTER TABLE ${table} DROP PRIMARY KEY;`;
  }
  if (
    isSqliteLike(engine) ||
    engine === "sqlserver" ||
    engine === "oracle" ||
    engine === "snowflake"
  ) {
    unsupportedSql("Changing primary key", engine);
  }
  return `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(constraintName, engine)};`;
}

/**
 * MySQL/MariaDB: drop and add the primary key in one statement. DDL
 * commits on its own there, so two statements could leave the table with
 * no primary key when the ADD fails.
 */
export function replacePrimaryKeySql(
  schema: string,
  tableName: string,
  columns: string[],
  engine?: DatabaseEngine
) {
  return `ALTER TABLE ${quoteTableName(schema, tableName, engine)} DROP PRIMARY KEY, ADD PRIMARY KEY (${columns
    .map((col) => quoteIdentifier(col, engine))
    .join(", ")});`;
}

export function addPrimaryKeySql(
  schema: string,
  tableName: string,
  columns: string[],
  engine?: DatabaseEngine
) {
  if (
    isSqliteLike(engine) ||
    engine === "sqlserver" ||
    engine === "oracle" ||
    engine === "snowflake"
  ) {
    unsupportedSql("Changing primary key", engine);
  }
  return `ALTER TABLE ${quoteTableName(schema, tableName, engine)} ADD PRIMARY KEY (${columns
    .map((col) => quoteIdentifier(col, engine))
    .join(", ")});`;
}

/** A MySQL string literal (backslashes escaped too, the default SQL mode). */
function mysqlStringLiteral(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}

const TIME_DEFAULT =
  /^(CURRENT_TIMESTAMP|NOW|LOCALTIME|LOCALTIMESTAMP|CURRENT_DATE|CURRENT_TIME|UTC_TIMESTAMP)(\(\d*\))?$/i;
const NUMBER = /^-?\d+(\.\d+)?$/;
/** One whole quoted literal: inner quotes doubled or escaped, nothing after. */
const SINGLE_QUOTED_LITERAL = /^'(?:[^'\\]|''|\\.)*'$/s;
const BIT_OR_HEX_LITERAL = /^(b'[01]*'|x'[0-9a-f]*')$/i;
const MYSQL_NUMERIC_TYPE =
  /^(tinyint|smallint|mediumint|int|integer|bigint|decimal|dec|numeric|fixed|float|double|real|bit|year|bool|boolean)\b/i;

/**
 * A MySQL/MariaDB column's current default, from the catalog, as a DEFAULT
 * expression to restate in MODIFY COLUMN; undefined when it has none.
 *
 * The text comes from the database and may have been written by anyone with
 * DDL rights, so it is only passed through when it is one well-formed
 * literal or keyword; anything else is quoted as a string or refused.
 */
export function mysqlDefaultFromCatalog(
  value: string | null | undefined,
  extra = "",
  engine?: DatabaseEngine,
  /** The column's type: a time keyword is a default only for time types. */
  dataType = ""
): string | undefined {
  if (value == null) return undefined;
  const text = value.trim();

  if (engine === "mariadb") {
    // MariaDB reports defaults as SQL: quoted literals, NULL, functions.
    if (
      /^NULL$/i.test(text) ||
      TIME_DEFAULT.test(text) ||
      NUMBER.test(text) ||
      SINGLE_QUOTED_LITERAL.test(text) ||
      BIT_OR_HEX_LITERAL.test(text)
    ) {
      return text;
    }
    unsupportedSql("Restating a column whose default is an expression", engine);
  }

  // MySQL reports a literal default as its raw text. MySQL 5.7 does not
  // mark CURRENT_TIMESTAMP on time columns as DEFAULT_GENERATED.
  if (
    TIME_DEFAULT.test(text) &&
    /^(timestamp|datetime|date|time)\b/i.test(dataType.trim())
  ) {
    return text;
  }
  if (/\bDEFAULT_GENERATED\b/i.test(extra)) {
    if (TIME_DEFAULT.test(text)) return text;
    unsupportedSql("Restating a column whose default is an expression", engine);
  }
  // A number or b'..' is one only on a numeric or BIT column; on a text
  // column "001" or "b'1'" is text.
  const type = dataType.trim();
  if (NUMBER.test(text) && MYSQL_NUMERIC_TYPE.test(type)) return text;
  if (/^b'[01]*'$/i.test(text) && /^bit\b/i.test(type)) return text;
  return mysqlStringLiteral(value);
}

/** What MySQL MODIFY COLUMN must restate besides type, null and default. */
export type MysqlColumnKeep = {
  extra?: string;
  comment?: string;
  collation?: string;
};

export function alterColumnStatements(args: {
  schema: string;
  tableName: string;
  columnName: string;
  dataType?: string;
  nullable?: boolean;
  defaultExpression?: string | null;
  engine?: DatabaseEngine;
  /** MySQL/MariaDB: the column's attributes MODIFY would otherwise drop. */
  mysqlKeep?: MysqlColumnKeep;
}) {
  const {
    schema,
    tableName,
    columnName,
    dataType,
    nullable,
    defaultExpression,
    engine,
    mysqlKeep = {},
  } = args;
  const table = quoteTableName(schema, tableName, engine);
  const col = quoteIdentifier(columnName, engine);

  if (isMysqlFamilyEngine(engine)) {
    if (!dataType) {
      unsupportedSql(
        "Changing MySQL column null/default without column type",
        engine
      );
    }
    // MODIFY replaces the whole definition: restate what it would drop.
    const extra = mysqlKeep.extra ?? "";
    if (/\b(VIRTUAL|STORED) GENERATED\b/i.test(extra)) {
      unsupportedSql("Changing a generated column", engine);
    }
    // Anything else in extra (INVISIBLE, ...) would be dropped: refuse.
    const unknownExtra = extra
      .replace(/\bAUTO_INCREMENT\b/gi, "")
      .replace(/\bDEFAULT_GENERATED\b/gi, "")
      .replace(/\bON UPDATE [A-Z_]+(?:\(\d*\))?/gi, "")
      .trim();
    if (unknownExtra) {
      unsupportedSql(`Restating a column marked "${unknownExtra}"`, engine);
    }
    const collation = mysqlKeep.collation?.trim() ?? "";
    const collateClause = /^[A-Za-z0-9_]+$/.test(collation)
      ? ` COLLATE ${collation}`
      : "";
    // Explicit NULL: a TIMESTAMP is NOT NULL without it on servers with
    // explicit_defaults_for_timestamp off (MySQL 5.7).
    const nullClause =
      nullable === false ? " NOT NULL" : nullable === true ? " NULL" : "";
    const defaultClause =
      defaultExpression === undefined
        ? ""
        : defaultExpression === null
          ? " DEFAULT NULL"
          : ` DEFAULT ${defaultExpression}`;
    const autoIncrement = /\bAUTO_INCREMENT\b/i.test(extra)
      ? " AUTO_INCREMENT"
      : "";
    const onUpdate = extra.match(/\bON UPDATE ([A-Z_]+(?:\(\d*\))?)/i)?.[1];
    const onUpdateClause = onUpdate
      ? ` ON UPDATE ${onUpdate.toUpperCase()}`
      : "";
    const commentClause = mysqlKeep.comment
      ? ` COMMENT ${mysqlStringLiteral(mysqlKeep.comment)}`
      : "";
    return [
      `ALTER TABLE ${table} MODIFY COLUMN ${col} ${dataType}${collateClause}${nullClause}${defaultClause}${autoIncrement}${onUpdateClause}${commentClause};`,
    ];
  }

  if (isSqliteLike(engine)) {
    unsupportedSql("Altering SQLite column type/null/default", engine);
  }

  if (engine === "sqlserver" || engine === "oracle" || engine === "snowflake") {
    unsupportedSql("Altering column type/null/default", engine);
  }

  const statements: string[] = [];
  if (dataType) {
    statements.push(
      `ALTER TABLE ${table} ALTER COLUMN ${col} TYPE ${dataType};`
    );
  }
  if (nullable !== undefined) {
    statements.push(
      `ALTER TABLE ${table} ALTER COLUMN ${col} ${nullable ? "DROP NOT NULL" : "SET NOT NULL"};`
    );
  }
  if (defaultExpression !== undefined) {
    statements.push(
      `ALTER TABLE ${table} ALTER COLUMN ${col} ${
        defaultExpression === null
          ? "DROP DEFAULT"
          : `SET DEFAULT ${defaultExpression}`
      };`
    );
  }
  return statements;
}

export function dropForeignKeySql(
  schema: string,
  tableName: string,
  constraintName: string,
  engine?: DatabaseEngine
) {
  const table = quoteTableName(schema, tableName, engine);
  if (isMysqlFamilyEngine(engine)) {
    return `ALTER TABLE ${table} DROP FOREIGN KEY ${quoteIdentifier(constraintName, engine)};`;
  }
  if (
    isSqliteLike(engine) ||
    engine === "sqlserver" ||
    engine === "oracle" ||
    engine === "snowflake"
  ) {
    unsupportedSql("Changing foreign keys", engine);
  }
  return `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${quoteIdentifier(constraintName, engine)};`;
}

export function addForeignKeySql(args: {
  schema: string;
  tableName: string;
  constraintName: string;
  columnName: string;
  refSchema: string;
  refTableName: string;
  refColumnName: string;
  engine?: DatabaseEngine;
}) {
  if (
    isSqliteLike(args.engine) ||
    args.engine === "sqlserver" ||
    args.engine === "oracle" ||
    args.engine === "snowflake"
  ) {
    unsupportedSql("Changing foreign keys", args.engine);
  }
  return `ALTER TABLE ${quoteTableName(args.schema, args.tableName, args.engine)} ADD CONSTRAINT ${quoteIdentifier(
    args.constraintName,
    args.engine
  )} FOREIGN KEY (${quoteIdentifier(args.columnName, args.engine)}) REFERENCES ${quoteTableName(
    args.refSchema,
    args.refTableName,
    args.engine
  )} (${quoteIdentifier(args.refColumnName, args.engine)});`;
}

export function dropIndexSql(
  schema: string,
  tableName: string,
  indexName: string,
  engine?: DatabaseEngine
) {
  if (isMysqlFamilyEngine(engine)) {
    return `DROP INDEX ${quoteIdentifier(indexName, engine)} ON ${quoteTableName(schema, tableName, engine)};`;
  }

  if (engine === "sqlserver") {
    return `DROP INDEX ${quoteIdentifier(indexName, engine)} ON ${quoteTableName(schema, tableName, engine)};`;
  }

  if (isSqliteLike(engine)) {
    return `DROP INDEX IF EXISTS ${quoteIdentifier(indexName, engine)};`;
  }

  return `DROP INDEX IF EXISTS ${quoteTableName(schema, indexName, engine)};`;
}

export function createIndexSql(args: {
  schema: string;
  tableName: string;
  indexName: string;
  columnName: string;
  unique?: boolean;
  algorithm?: string;
  engine?: DatabaseEngine;
}) {
  const unique = args.unique ? "UNIQUE " : "";
  const table = quoteTableName(args.schema, args.tableName, args.engine);
  const index = quoteIdentifier(args.indexName, args.engine);
  // Several columns come comma-separated ("last_name,first_name").
  const column = args.columnName
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => quoteIdentifier(name, args.engine))
    .join(", ");

  if (isMysqlFamilyEngine(args.engine)) {
    const using = args.algorithm ? ` USING ${args.algorithm}` : "";
    return `CREATE ${unique}INDEX ${index}${using} ON ${table} (${column});`;
  }

  const using =
    args.engine === "postgres" && args.algorithm
      ? ` USING ${args.algorithm}`
      : "";
  return `CREATE ${unique}INDEX ${index} ON ${table}${using} (${column});`;
}

function toHexUtf8(value: string) {
  return Array.from(new TextEncoder().encode(value))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeUtf8Hex(hex: string) {
  if (!hex) return "";
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return new TextDecoder().decode(bytes);
}

/** Shared collation for MySQL string literals and comparisons (avoids 8.0 default vs legacy column mix). */
export const MYSQL_UTF8MB4_COLLATION = "utf8mb4_unicode_ci";

export function mysqlStringCompareExpr(expr: string) {
  return `CONVERT(${expr} USING utf8mb4) COLLATE ${MYSQL_UTF8MB4_COLLATION}`;
}

const MYSQL_HEX_LITERAL_RE =
  /CONVERT\s*\(\s*UNHEX\s*\(\s*'([0-9a-fA-F]*)'\s*\)\s+USING\s+utf8mb4\s*\)(?:\s+COLLATE\s+[\w_]+)?/gi;
const POSTGRES_DECODE_HEX_RE =
  /decode\s*\(\s*'([0-9a-fA-F]*)'\s*,\s*'hex'\s*\)/gi;
const ORACLE_HEX_TO_RAW_RE = /HEXTORAW\s*\(\s*'([0-9a-fA-F]*)'\s*\)/gi;
const MYSQL_BLOB_LITERAL_RE = /\bX'([0-9a-fA-F]*)'/gi;
const SQLSERVER_HEX_LITERAL_RE = /\b0x([0-9a-fA-F]+)\b/g;
const SQLSERVER_UNICODE_LITERAL_RE = /\bN'((?:''|[^'])*)'/g;

/** Human-readable quoted literal for UI preview and SQL history. */
export function sqlQuotedStringLiteral(
  value: unknown,
  engine?: DatabaseEngine
) {
  const text = String(value);
  if (isSqlServerEngine(engine)) {
    return `N'${text.replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, "''")}'`;
}

function sqlDisplayQuotedLiteral(value: unknown) {
  const text = String(value);
  return `'${text.replace(/'/g, "''")}'`;
}

function hexBytesToDisplayLiteral(hex: string) {
  if (!hex) return "''";
  const text = decodeUtf8Hex(hex);
  if (text && /^[\t\n\r\x20-\x7E\u0080-\uFFFF]*$/.test(text)) {
    return sqlDisplayQuotedLiteral(text);
  }
  return `'${hex.toLowerCase()}'`;
}

function replaceMysqlStringCompareExprs(sql: string) {
  return sql.replace(
    new RegExp(
      `CONVERT\\s*\\(\\s*(\`(?:[^\`]|\\\\\`)*\`)\\s+USING\\s+utf8mb4\\s*\\)\\s+COLLATE\\s+${MYSQL_UTF8MB4_COLLATION}`,
      "gi"
    ),
    "$1"
  );
}

function replaceMysqlHexLiterals(sql: string) {
  return sql.replace(MYSQL_HEX_LITERAL_RE, (_, hex: string) =>
    sqlDisplayQuotedLiteral(decodeUtf8Hex(hex))
  );
}

function replacePostgresHexLiterals(sql: string) {
  return sql.replace(POSTGRES_DECODE_HEX_RE, (_, hex: string) =>
    hexBytesToDisplayLiteral(hex)
  );
}

function replaceOracleHexLiterals(sql: string) {
  return sql.replace(ORACLE_HEX_TO_RAW_RE, (_, hex: string) =>
    hexBytesToDisplayLiteral(hex)
  );
}

function replaceMysqlBlobLiterals(sql: string) {
  return sql.replace(MYSQL_BLOB_LITERAL_RE, (_, hex: string) =>
    hexBytesToDisplayLiteral(hex)
  );
}

function replaceSqlServerLiterals(sql: string) {
  return sql
    .replace(SQLSERVER_UNICODE_LITERAL_RE, (_, inner: string) => `'${inner}'`)
    .replace(SQLSERVER_HEX_LITERAL_RE, (_, hex: string) =>
      hexBytesToDisplayLiteral(hex)
    );
}

/** Rewrites engine-specific encoded literals into normal quoted strings for display. */
export function sqlForDisplay(sql: string, engine?: DatabaseEngine) {
  let out = sql;

  if (!engine || isMysqlFamilyEngine(engine)) {
    out = replaceMysqlHexLiterals(out);
    out = replaceMysqlBlobLiterals(out);
    out = replaceMysqlStringCompareExprs(out);
  }

  if (!engine || engine === "postgres") {
    out = replacePostgresHexLiterals(out);
  }

  if (!engine || engine === "oracle") {
    out = replaceOracleHexLiterals(out);
  }

  if (!engine || isSqlServerEngine(engine)) {
    out = replaceSqlServerLiterals(out);
  }

  return out;
}

export function sqlStringLiteral(value: unknown, engine?: DatabaseEngine) {
  const text = String(value);
  if (isMysqlFamilyEngine(engine)) {
    return `CONVERT(UNHEX('${toHexUtf8(text)}') USING utf8mb4) COLLATE ${MYSQL_UTF8MB4_COLLATION}`;
  }
  return sqlQuotedStringLiteral(text, engine);
}

export function normalizeJsonValue(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return "";
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed === "string") {
        const nested = parsed.trim();
        if (nested === "") return "";
        try {
          return JSON.stringify(JSON.parse(nested));
        } catch {
          return parsed;
        }
      }
      return JSON.stringify(parsed);
    } catch {
      return value;
    }
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function decodeBytesAsUtf8Text(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return Array.from(bytes, (byte) => String.fromCharCode(byte)).join("");
  }
}

/**
 * Unwrap typed cell values for SQL literals.
 * BytesB64 stays as Uint8Array only for blob/binary columns; otherwise decode
 * UTF-8 text. MySQL text protocol often labels ints/datetimes as BytesB64 with
 * binary charset metadata — String(Uint8Array) would become comma-joined codes
 * (e.g. id 3 -> 51, datetime -> "50,48,50,54,...").
 */
function unwrapCellValue(value: unknown, dbType?: string): unknown {
  if (value && typeof value === "object") {
    const cell = value as Record<string, unknown>;
    if (cell.t === "Null") return null;
    if (cell.t === "BytesB64" && typeof cell.v === "string") {
      const bytes = decodeBytesB64(cell.v);
      if (!bytes) return cell.v;
      if (isBlobColumnType(dbType)) return bytes;
      return decodeBytesAsUtf8Text(bytes);
    }
    if ("v" in cell) return cell.v;
  }
  return value;
}

function coerceNonBlobBytesToText(raw: unknown, dbType?: string): unknown {
  if (isBlobColumnType(dbType)) return raw;
  if (raw instanceof Uint8Array) return decodeBytesAsUtf8Text(raw);
  if (raw instanceof ArrayBuffer)
    return decodeBytesAsUtf8Text(new Uint8Array(raw));
  return raw;
}

export function formatSqlValue(
  value: unknown,
  dbType: string | undefined,
  engine?: DatabaseEngine
): string {
  let raw = unwrapCellValue(value, dbType);
  if (raw === null || raw === undefined) return "NULL";

  if (isBlobColumnType(dbType)) {
    const bytes =
      raw instanceof Uint8Array
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : null;
    const hexText =
      typeof raw === "string" ? raw.trim().replace(/^0x/i, "") : "";
    if (!bytes && hexText && /^[0-9a-f]+$/i.test(hexText)) {
      const normalizedHex = hexText.length % 2 === 0 ? hexText : `0${hexText}`;
      if (engine === "postgres") return `decode('${normalizedHex}', 'hex')`;
      if (engine === "sqlserver") return `0x${normalizedHex}`;
      if (engine === "oracle") return `HEXTORAW('${normalizedHex}')`;
      return `X'${normalizedHex}'`;
    }
    if (bytes) {
      const hex = Array.from(bytes, (byte) =>
        byte.toString(16).padStart(2, "0")
      ).join("");
      if (engine === "postgres") return `decode('${hex}', 'hex')`;
      if (engine === "sqlserver") return `0x${hex}`;
      if (engine === "oracle") return `HEXTORAW('${hex}')`;
      return `X'${hex}'`;
    }
  }

  raw = coerceNonBlobBytesToText(raw, dbType);

  // PostgreSQL arrays are held as JSON array text; text that is not one
  // (an array literal typed in the editor) stays a string literal.
  if (engine === "postgres" && isPostgresArrayType(dbType)) {
    const arraySql = pgArrayValueSql(
      typeof raw === "string" ? raw : JSON.stringify(raw),
      dbType!,
      (text) => sqlStringLiteral(text, engine)
    );
    if (arraySql) return arraySql;
  }

  if (isJsonColumnType(dbType)) {
    const jsonText = normalizeJsonValue(raw);
    if (jsonText.trim() === "" || jsonText.trim().toLowerCase() === "null") {
      return "NULL";
    }
    return sqlStringLiteral(jsonText, engine);
  }

  if (typeof raw === "boolean") {
    if (isSqlServerEngine(engine)) return raw ? "1" : "0";
    return raw ? "TRUE" : "FALSE";
  }

  if (typeof raw === "number" && Number.isFinite(raw)) {
    if (engine === "clickhouse") {
      const scale = clickhouseDecimalScale(dbType);
      if (scale !== null) {
        return formatClickhouseDecimalForSql(raw, scale);
      }
    }
    return String(raw);
  }

  if (engine === "clickhouse") {
    const scale = clickhouseDecimalScale(dbType);
    if (scale !== null) {
      const text = String(raw).trim();
      if (text !== "" && text.toLowerCase() !== "null") {
        const numberValue = Number(text);
        if (Number.isFinite(numberValue)) {
          return formatClickhouseDecimalForSql(numberValue, scale);
        }
      }
    }
  }

  if (isNumericColumnType(dbType)) {
    const text = String(raw).trim();
    if (text === "" || text.toLowerCase() === "null") return "NULL";
    const numberValue = Number(text);
    if (Number.isFinite(numberValue)) {
      if (engine === "clickhouse") {
        const scale = clickhouseDecimalScale(dbType);
        if (scale !== null) {
          return formatClickhouseDecimalForSql(numberValue, scale);
        }
      }
      return String(numberValue);
    }
  }

  return sqlStringLiteral(raw, engine);
}
