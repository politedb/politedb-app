import type { DatabaseEngine } from "src/types";

export function isSqlServerEngine(engine?: DatabaseEngine) {
  return engine === "sqlserver";
}

export function isMysqlFamilyEngine(engine?: DatabaseEngine) {
  return engine === "mysql" || engine === "mariadb";
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

export function isNumericColumnType(dbType: string | undefined): boolean {
  if (!dbType || typeof dbType !== "string") return false;
  return /^(bit|tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial|float|double|float4|float8|real|double\s*precision|numeric|decimal)(\s*\([^)]*\))?(\s+unsigned)?$/i.test(
    dbType.trim()
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
  if (engine === "sqlite" || !schema) {
    return quoteIdentifier(tableName, engine);
  }
  return `${quoteIdentifier(schema, engine)}.${quoteIdentifier(tableName, engine)}`;
}

export function unsupportedSql(feature: string, engine?: DatabaseEngine): never {
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

  if (engine === "sqlite") {
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

export function truncateTableSql(
  schema: string,
  tableName: string,
  opts?: { restartIdentity?: boolean; cascade?: boolean },
  engine?: DatabaseEngine
) {
  const table = quoteTableName(schema, tableName, engine);

  if (engine === "sqlite") {
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
  return `ALTER TABLE ${quoteTableName(schema, tableName, engine)} ADD COLUMN ${columnDefinition};`;
}

export function dropColumnSql(
  schema: string,
  tableName: string,
  columnName: string,
  engine?: DatabaseEngine
) {
  return `ALTER TABLE ${quoteTableName(schema, tableName, engine)} DROP COLUMN ${quoteIdentifier(columnName, engine)};`;
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

  if (engine === "sqlite") {
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
    return `CREATE ${unique}INDEX ${index} ON ${table} (${column})${using};`;
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

export function sqlStringLiteral(value: unknown, engine?: DatabaseEngine) {
  const text = String(value);
  if (isMysqlFamilyEngine(engine)) {
    return `CONVERT(UNHEX('${toHexUtf8(text)}') USING utf8mb4)`;
  }
  if (isSqlServerEngine(engine)) {
    return `N'${text.replace(/'/g, "''")}'`;
  }
  return `'${text.replace(/'/g, "''")}'`;
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
    return String(raw);
  }

  if (isNumericColumnType(dbType)) {
    const text = String(raw).trim();
    if (text === "" || text.toLowerCase() === "null") return "NULL";
    const numberValue = Number(text);
    if (Number.isFinite(numberValue)) return String(numberValue);
  }

  return sqlStringLiteral(raw, engine);
}
