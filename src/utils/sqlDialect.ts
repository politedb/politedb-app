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
