import type { DatabaseEngine } from "src/types";
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
  return /\b(blob|binary|varbinary|bytea|raw|long raw|image)\b/i.test(
    dbType.trim()
  );
}

import {
  clickhouseDecimalScale,
  formatClickhouseDecimalForSql,
} from "./clickhouse";

export {
  clickhouseDecimalScale,
  formatClickhouseDecimalForSql,
  normalizeClickhouseDbType,
  unwrapClickhouseType,
} from "./clickhouse";

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

export function alterColumnStatements(args: {
  schema: string;
  tableName: string;
  columnName: string;
  dataType?: string;
  nullable?: boolean;
  defaultExpression?: string | null;
  engine?: DatabaseEngine;
}) {
  const {
    schema,
    tableName,
    columnName,
    dataType,
    nullable,
    defaultExpression,
    engine,
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
    const nullClause = nullable === false ? " NOT NULL" : "";
    const defaultClause =
      defaultExpression === undefined
        ? ""
        : defaultExpression === null
          ? " DEFAULT NULL"
          : ` DEFAULT ${defaultExpression}`;
    return [
      `ALTER TABLE ${table} MODIFY COLUMN ${col} ${dataType}${nullClause}${defaultClause};`,
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
  const column = quoteIdentifier(args.columnName, args.engine);

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

function unwrapCellValue(value: unknown): unknown {
  if (value && typeof value === "object") {
    const cell = value as Record<string, unknown>;
    if (cell.t === "Null") return null;
    if ("v" in cell) return cell.v;
  }
  return value;
}

export function formatSqlValue(
  value: unknown,
  dbType: string | undefined,
  engine?: DatabaseEngine
): string {
  const raw = unwrapCellValue(value);
  if (raw === null || raw === undefined) return "NULL";

  if (isBlobColumnType(dbType)) {
    const bytes =
      raw instanceof Uint8Array
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : null;
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
